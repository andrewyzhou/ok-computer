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
  // the address of the from header, parsed. a text test would let '"bank@x" <evil@y>' pass for bank@x.
  const from = fromAddress(header(message, 'From'));
  if (!from || from !== sender.trim().toLowerCase()) {
    return { way: 'refused', text: `the message is from ${from ?? 'an address that cannot be read'}, not from ${JSON.stringify(sender)}` };
  }
  const targets = unsubscribeTargets(header(message, 'List-Unsubscribe'));
  if (!targets.includes(target)) return { way: 'refused', text: `the message does not offer ${JSON.stringify(target)}. It offers: ${targets.join(' ') || 'nothing'}` };
  if (target.toLowerCase().startsWith('mailto:')) {
    if (!send) return { way: 'refused', text: 'this sender unsubscribes by mail, and sending is off for the google integration' };
    const mailto = new URL(target);
    return { way: 'mailto', to: decodeURIComponent(mailto.pathname), subject: mailto.searchParams.get('subject') ?? 'unsubscribe', body: mailto.searchParams.get('body') ?? 'unsubscribe' };
  }
  // rfc 8058 needs the post header, and a dkim signature that covers both headers. without a passed dkim check the
  // header can be forged, and the post would go to a server of the forger.
  if (!/List-Unsubscribe=One-Click/i.test(header(message, 'List-Unsubscribe-Post'))) {
    return { way: 'refused', text: 'the sender offers no one-click unsubscribe. The owner can open the link in a browser' };
  }
  const results = (message.payload?.headers ?? []).filter((each) => each.name?.toLowerCase() === 'authentication-results').map((each) => each.value ?? '');
  if (!results.some((value) => /\bdkim=pass\b/i.test(value))) {
    return { way: 'refused', text: 'gmail did not see a passing dkim signature on this message, so its unsubscribe header can be forged' };
  }
  return { way: 'one-click' };
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
  text: string;
}

const TIMEOUT_MS = 15_000;
const BODY = 'List-Unsubscribe=One-Click';

// rfc 8058: a post with the fixed body, no cookies, no redirects. the answer body is read up to 64 kb and dropped.
export function oneClick(target: string, lookup: LookupFunction = publicOnlyLookup): Promise<OneClickResult> {
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
        timeout: TIMEOUT_MS,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(BODY), 'user-agent': 'ok-computer' },
      },
      (res) => {
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) res.destroy();
        });
        res.on('close', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve({ ok: true, sent: true, text: `the sender answered ${status}` });
          else if (status >= 300 && status < 400) resolve({ ok: false, sent: true, text: `the sender answered with a redirect (${status}), which one-click does not follow. The unsubscribe probably did not finish.` });
          else resolve({ ok: false, sent: true, text: `the sender answered ${status}` });
        });
      },
    );
    req.on('socket', (socket) => socket.on('connect', () => (connected = true)));
    req.on('timeout', () => req.destroy(new Error('the sender did not answer in time')));
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, sent: connected, ...(err.code === 'EPRIVATE' ? { refused: true } : {}), text: err.message }));
    req.end(BODY);
  });
}
