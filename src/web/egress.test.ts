import { describe, expect, it, vi } from 'vitest';

// documentation addresses stand for the addresses of this pc, so the test does not depend on the network of the pc.
// 2001:db8::/32 is private in the egress rules, so the global address is a public one that no pc here has.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () => ({
    wifi: [
      { address: '2a00:1450:4001:82a::25c6', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: '2a00:1450:4001:82a::25c6/64', scopeid: 0 },
      { address: '8.20.30.40', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '8.20.30.40/24' },
    ],
    loopback: [{ address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '', internal: true, cidr: '::1/128', scopeid: 0 }],
  }),
}));

const { isPublicAddress } = await import('./egress.js');

describe('the addresses of this pc and its lan', () => {
  it.each([
    ['the global ipv6 address of this pc', '2a00:1450:4001:82a::25c6', false],
    ['another device of the same /64', '2a00:1450:4001:82a:1234:5678:9abc:def0', false],
    ['a host of another /64', '2a00:1450:4001:82b::1', true],
    ['a public ipv4 address of this pc', '8.20.30.40', false],
    ['its neighbour, which can be any host on the internet', '8.20.30.41', true],
    // the /64 of ::1 would hold every ipv4 address, because a block list also reads one as ::ffff:a.b.c.d.
    ['a public ipv4 address', '9.9.9.9', true],
  ])('%s (%s) is public: %s', (_name, ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});
