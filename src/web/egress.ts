import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

// the agent must not reach the owner's own machine or network: the dashboard, a router page, or a printer. a page can
// ask for such an address, and a name can point to one, so the check runs on the address that the connection uses.
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

// an ipv6 address can carry an ipv4 address: ::ffff:a.b.c.d, the nat64 prefix 64:ff9b::/96, and 6to4 2002::/16.
function embeddedV4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  const parts = hex ?? sixToFour;
  if (!parts) return undefined;
  const high = parseInt(parts[1]!, 16);
  const low = parseInt(parts[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

// a global ipv6 address of this pc is not in a private range, and the router gives each device of the lan an address of
// the same /64. a probe reached a server on this pc that listened on every address (r4). so each address of this pc,
// and the /64 of each of its ipv6 addresses, is the owner's own. the addresses change, for example with a new network
// or a new temporary ipv6 address, so the list is read again after a short time.
let own: { at: number; list: BlockList } | undefined;
function ownNetwork(): BlockList {
  if (own && performance.now() - own.at < 10_000) return own.list;
  const list = new BlockList();
  for (const each of Object.values(networkInterfaces()).flat()) {
    const address = each?.address.replace(/%.*$/, '');
    // a node block list matches an ipv4 address against the ipv6 rules too, as ::ffff:a.b.c.d. the /64 of ::1 would
    // then hold every ipv4 address. the private ranges already cover the loopback and the link-local addresses.
    if (!each || !address || PRIVATE.check(address, each.family === 'IPv4' ? 'ipv4' : 'ipv6')) continue;
    if (each.family === 'IPv4') list.addAddress(address, 'ipv4');
    else list.addSubnet(address, 64, 'ipv6');
  }
  own = { at: performance.now(), list };
  return list;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !PRIVATE.check(ip, 'ipv4') && !ownNetwork().check(ip, 'ipv4');
  if (family !== 6) return false;
  const inner = embeddedV4(ip);
  if (inner) return isPublicAddress(inner);
  return !PRIVATE.check(ip, 'ipv6') && !ownNetwork().check(ip, 'ipv6');
}

export type Resolve = (host: string) => Promise<string[]>;

export const systemResolve: Resolve = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((each) => each.address);

// tests put fixture sites on the loopback address, so they give their own address rule. the app always uses
// isPublicAddress.
export interface Egress {
  resolve: Resolve;
  addressAllowed: (ip: string) => boolean;
}

export const publicEgress: Egress = { resolve: systemResolve, addressAllowed: isPublicAddress };

export type Checked = { ok: true; address: string } | { ok: false; reason: string };

// every address of the name must be allowed. a name with one public and one private address could reach the private
// one on a retry of the connection.
export async function checkHost(egress: Egress, host: string): Promise<Checked> {
  const bare = host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(bare) ? [bare] : await egress.resolve(bare);
  } catch (err) {
    return { ok: false, reason: `the name ${host} did not resolve (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  if (!addresses.length) return { ok: false, reason: `the name ${host} has no address` };
  const blocked = addresses.find((address) => !egress.addressAllowed(address));
  if (blocked) return { ok: false, reason: `${host} points to ${blocked}, an address on this machine or its local network` };
  return { ok: true, address: addresses[0]! };
}

export type UrlShape = { ok: true; url: URL } | { ok: false; reason: string };

// only plain web addresses. a user name or password in the address is refused, because the agent can then send a
// secret in a form that the redaction does not know.
export function checkUrlShape(text: string): UrlShape {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `${JSON.stringify(text.slice(0, 200))} is not a full web address` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `only http and https addresses work, not ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: 'an address with a user name or a password is refused' };
  return { ok: true, url };
}
