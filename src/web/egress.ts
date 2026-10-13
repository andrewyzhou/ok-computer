import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !PRIVATE.check(ip, 'ipv4');
  if (family !== 6) return false;
  const inner = embeddedV4(ip);
  if (inner) return isPublicAddress(inner);
  return !PRIVATE.check(ip, 'ipv6');
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
