import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { checkHost, checkUrlShape, type Egress } from './egress.js';

export interface FetchLimits {
  // the limit applies to the bytes after decompression, so a small compressed body cannot fill the memory.
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
}

const TEXTUAL = /^\s*(text\/|application\/([\w.+-]*\+)?(xml|json)\b|application\/(xhtml\+xml|javascript)\b)/i;

export const FETCH_LIMITS: FetchLimits = { maxBytes: 5_000_000, maxRedirects: 5, timeoutMs: 20_000 };

export type Fetched =
  | { ok: true; url: string; status: number; contentType: string; text: string; cut: boolean; redirects: string[] }
  | { ok: false; reason: string; redirects: string[] };

// the lookup checks the address that the socket connects to. a separate check before the request would let a name
// give a public address to the check and a private address to the connection.
function checkedLookup(egress: Egress): LookupFunction {
  return (hostname, options, callback) => {
    checkHost(egress, hostname).then(
      (checked) => {
        if (!checked.ok) return callback(Object.assign(new Error(checked.reason), { code: 'EBLOCKED' }), '', 0);
        const family = checked.address.includes(':') ? 6 : 4;
        // with autoSelectFamily, node asks for every address.
        if ((options as { all?: boolean }).all) return (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: checked.address, family }]);
        callback(null, checked.address, family);
      },
      (err: Error) => callback(err, '', 0),
    );
  };
}

function decoded(res: IncomingMessage): Readable {
  switch ((res.headers['content-encoding'] ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
}

function decodeText(bytes: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType, bytes)).decode(bytes);
  } catch {
    // an unknown label throws. utf-8 with replacement characters is still readable.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  body?: { bytes: Buffer; cut: boolean };
}

function oneHop(url: URL, egress: Egress, limits: FetchLimits, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: 'GET',
        lookup: checkedLookup(egress),
        signal,
        headers: { 'accept-encoding': 'gzip, deflate, br', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; ok-computer)' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ status, location, contentType });
        }
        // a pdf or an image is not text. the body is not read, so a large file costs nothing.
        if (contentType && !TEXTUAL.test(contentType)) {
          res.destroy();
          return resolve({ status, contentType });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let cut = false;
        const body = decoded(res);
        body.on('data', (chunk: Buffer) => {
          if (cut) return;
          const room = limits.maxBytes - size;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            size = limits.maxBytes;
            cut = true;
            // the rest of the body is not read. this also stops a decompression bomb.
            req.destroy();
            resolve({ status, contentType, body: { bytes: Buffer.concat(chunks), cut } });
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        body.on('end', () => resolve({ status, contentType, body: { bytes: Buffer.concat(chunks), cut } }));
        body.on('error', (err) => (cut ? undefined : reject(err)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// fetchText follows at most maxRedirects redirects, and each hop gets the same checks as the first address.
export async function fetchText(egress: Egress, address: string, signal: AbortSignal, limits: FetchLimits = FETCH_LIMITS): Promise<Fetched> {
  const redirects: string[] = [];
  const shape = checkUrlShape(address);
  if (!shape.ok) return { ok: false, reason: shape.reason, redirects };
  let url = shape.url;
  const all = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]);
  for (let hop = 0; ; hop++) {
    // node does not call the lookup for an address such as 127.0.0.1, so such an address gets its check here.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal)) {
      const checked = await checkHost(egress, literal);
      if (!checked.ok) return { ok: false, reason: checked.reason, redirects };
    }
    let result: Hop;
    try {
      result = await oneHop(url, egress, limits, all);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EBLOCKED') return { ok: false, reason: e.message, redirects };
      if (all.aborted) return { ok: false, reason: signal.aborted ? 'the run stopped' : `no answer within ${limits.timeoutMs / 1000} s`, redirects };
      return { ok: false, reason: `the request failed: ${e.code ?? e.message}`, redirects };
    }
    if (result.location !== undefined) {
      if (hop >= limits.maxRedirects) return { ok: false, reason: `more than ${limits.maxRedirects} redirects`, redirects };
      const next = checkUrlShape(new URL(result.location, url).href);
      if (!next.ok) return { ok: false, reason: `a redirect went to a refused address: ${next.reason}`, redirects };
      redirects.push(next.url.href);
      url = next.url;
      continue;
    }
    const body = result.body;
    if (!body) return { ok: false, reason: `the page is ${result.contentType}, not text. Use the browser to see it.`, redirects };
    return { ok: true, url: url.href, status: result.status, contentType: result.contentType, text: decodeText(body.bytes, result.contentType), cut: body.cut, redirects };
  }
}
