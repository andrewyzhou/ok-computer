import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { gmail_v1 } from '@googleapis/gmail';
import { fromAddress, header } from './mime.js';

// the targets of a List-Unsubscribe header, in their order. only https and mailto count. an http link would send
// the unsubscribe in clear text, and other schemes are not for a server.
export function unsubscribeTargets(header: string): string[] {
  return [...header.matchAll(/<([^<>]+)>/g)].map((match) => match[1]!.trim()).filter((target) => /^(https:|mailto:)/i.test(target));
}

// the way to unsubscribe that the owner approved, or the reason why the call must not run. the checks read the
// message again at run time, because the model gives the sender and the target, and the card shows them.
export type UnsubscribePlan = { way: 'mailto'; to: string; subject: string; body: string } | { way: 'one-click' } | { way: 'refused'; text: string };

export function planUnsubscribe(message: gmail_v1.Schema$Message, sender: string, target: string, send: boolean): UnsubscribePlan {
  // the address of the from header, parsed. a text test would let '"bank@x" <evil@y>' pass for bank@x. the refusals
  // do not quote the from header or its domain. the sender writes them, and this output is not marked as untrusted.
  const from = fromAddress(header(message, 'From'));
  if (!from || from !== sender.trim().toLowerCase()) return { way: 'refused', text: `the message is not from ${JSON.stringify(sender)}. gmail_read_thread shows its sender` };
  // the refusal does not quote the targets of the message for the same reason. the model can read them again with
  // gmail_read_thread.
  const targets = unsubscribeTargets(header(message, 'List-Unsubscribe'));
  if (!targets.includes(target)) return { way: 'refused', text: `the message does not offer ${JSON.stringify(target)}. gmail_read_thread shows the targets that it offers` };
  const mail = target.toLowerCase().startsWith('mailto:');
  if (mail && !send) return { way: 'refused', text: 'this sender unsubscribes by mail, and sending is off for the google integration' };
  // rfc 8058 needs the post header for a one-click.
  if (!mail && !/List-Unsubscribe=One-Click/i.test(header(message, 'List-Unsubscribe-Post'))) {
    return { way: 'refused', text: 'the sender offers no one-click unsubscribe. The owner can open the link in a browser' };
  }
  // both ways need a dkim signature of the from domain that covers the unsubscribe headers. without it a forger
  // writes the header: a one-click post goes to a server of the forger, and a mailto makes the owner's account send a
  // mail with the forger's recipient, subject and body.
  const keys = mail ? ['From', 'List-Unsubscribe'] : ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post'];
  // a signature that names a header once signs its last instance (rfc 6376 5.4.2). a resent signed mail with an added
  // header on top still passes, and the code reads the top one. so each of these headers must be there one time.
  const headers = message.payload?.headers ?? [];
  const twice = keys.find((key) => headers.filter((each) => each.name?.toLowerCase() === key.toLowerCase()).length > 1);
  if (twice) return { way: 'refused', text: `the message has more than one ${twice} header, so an added one cannot be told from the signed one` };
  const domain = from.slice(from.lastIndexOf('@') + 1);
  const passes = gmailDkimPasses(message).filter((pass) => aligned(pass.domain, domain));
  if (!passes.length) {
    return { way: 'refused', text: 'gmail did not see a passing dkim signature of the from domain on this message, so its unsubscribe header can be forged. The owner can unsubscribe by hand' };
  }
  const signatures = headers.filter((each) => each.name?.toLowerCase() === 'dkim-signature').map((each) => tags(each.value ?? ''));
  // gmail names a passing signature by its domain and the first characters of b=. a forged signature can copy both.
  // when more than one signature fits a pass, the code cannot know which one gmail checked, so that pass counts for
  // nothing.
  const needed = keys.slice(1).map((key) => key.toLowerCase());
  const covered = passes.some((pass) => {
    const fits = signatures.filter((tag) => tag.d?.toLowerCase() === pass.domain && (!pass.b || (tag.b ?? '').startsWith(pass.b)));
    const signed = fits.length === 1 ? (fits[0]!.h ?? '').toLowerCase().split(':') : [];
    return needed.every((key) => signed.includes(key));
  });
  if (!covered) return { way: 'refused', text: 'the dkim signature of the from domain does not cover the unsubscribe headers, so they can be forged. The owner can unsubscribe by hand' };
  if (!mail) return { way: 'one-click' };
  const mailto = new URL(target);
  return { way: 'mailto', to: decodeURIComponent(mailto.pathname), subject: mailto.searchParams.get('subject') ?? 'unsubscribe', body: mailto.searchParams.get('body') ?? 'unsubscribe' };
}

// the passing dkim results in the authentication-results header that gmail added. gmail puts its header on top. a
// header further down, or one from another server, can come from the sender. header.b is the start of the signature,
// so it names which signature passed.
function gmailDkimPasses(message: gmail_v1.Schema$Message): Array<{ domain: string; b?: string }> {
  const top = (message.payload?.headers ?? []).find((each) => each.name?.toLowerCase() === 'authentication-results')?.value ?? '';
  const [server, ...results] = top.replace(/\([^()]*\)/g, ' ').split(';').map((each) => each.trim());
  if (server?.toLowerCase() !== 'mx.google.com') return [];
  return results.flatMap((result) => {
    if (!/^dkim\s*=\s*pass\b/i.test(result)) return [];
    const domain = /\bheader\.d=([^\s;]+)/i.exec(result)?.[1] ?? /\bheader\.i=[^\s;@]*@([^\s;]+)/i.exec(result)?.[1];
    const b = /\bheader\.b=([^\s;]+)/i.exec(result)?.[1];
    return domain ? [{ domain: domain.toLowerCase(), ...(b ? { b } : {}) }] : [];
  });
}

// relaxed alignment: the signing domain is the from domain, a parent of it, or a child of it. a name without a dot is
// a top-level domain, and it never signs mail.
const aligned = (signer: string, from: string) => signer.includes('.') && (signer === from || from.endsWith(`.${signer}`) || signer.endsWith(`.${from}`));

// the tags of a dkim-signature header, without the folding white space.
function tags(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .replace(/\s+/g, '')
      .split(';')
      .filter((each) => each.indexOf('=') > 0)
      .map((each) => [each.slice(0, each.indexOf('=')), each.slice(each.indexOf('=') + 1)]),
  );
}

// a sender writes the header, so a link can point at the pc itself, the router, or a cloud metadata address. a post
// there with the owner's approval is still a request that the owner did not mean.
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

// the block list also checks an ipv4 address inside ipv6 (::ffff:127.0.0.1 and ::ffff:7f00:1) against the ipv4 rules.
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// the check runs inside the connect, on the address that the socket uses. a check before the request would leave a
// gap where a second dns answer (dns rebinding) gives a private address.
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    const bad = addresses.find((each) => isPrivateAddress(each.address));
    if (bad || !addresses.length) {
      const refused = Object.assign(new Error(`${hostname} resolves to a private address (${bad?.address ?? 'none'})`), { code: 'EPRIVATE' });
      return callback(refused, '', 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

export interface OneClickResult {
  ok: boolean;
  // false when the request surely did not leave the pc.
  sent: boolean;
  // true when the app refused the target, for example a private address. a second approval cannot help then.
  refused?: boolean;
  status?: number;
  text: string;
}

const TIMEOUT_MS = 15_000;
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

// rfc 8058: a post with the fixed body, no cookies, no redirects. the status line is the answer. the body is read up
// to 64 kb and dropped. one deadline covers the whole request: an idle timeout alone let a sender that sends one byte
// each second hold the approved call for hours.
export function oneClick(target: string, lookup: LookupFunction = publicOnlyLookup, timeoutMs = TIMEOUT_MS): Promise<OneClickResult> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return Promise.resolve({ ok: false, sent: false, refused: true, text: 'the unsubscribe link is not a valid url' });
  }
  if (url.protocol !== 'https:') return Promise.resolve({ ok: false, sent: false, refused: true, text: 'a one-click unsubscribe needs an https link' });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // a literal address skips the lookup, so it is checked here.
  if (isIP(host) && isPrivateAddress(host)) return Promise.resolve({ ok: false, sent: false, refused: true, text: `the unsubscribe link points at a private address (${host})` });
  return new Promise((resolve) => {
    let connected = false;
    const req = request(
      url,
      {
        method: 'POST',
        lookup,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(ONE_CLICK_BODY), 'user-agent': 'ok-computer' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve({ ok: true, sent: true, status, text: `the sender answered ${status}` });
        else if (status >= 300 && status < 400) resolve({ ok: false, sent: true, status, text: `the sender answered with a redirect (${status}), which one-click does not follow. The unsubscribe probably did not finish.` });
        else resolve({ ok: false, sent: true, status, text: `the sender answered ${status}` });
        let size = 0;
        // the deadline can stop the body. the result is known then, so that error is not a failure.
        res.on('error', () => {});
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) res.destroy();
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('the sender did not answer in time')), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('socket', (socket) => socket.on('connect', () => (connected = true)));
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, sent: connected, ...(err.code === 'EPRIVATE' ? { refused: true } : {}), text: err.message }));
    req.end(ONE_CLICK_BODY);
  });
}
