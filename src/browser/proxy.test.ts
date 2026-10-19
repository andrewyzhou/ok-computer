import { request } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from './proxy.js';

// a raw server, because node refuses to send these status lines itself.
let upstream: Server;
let port = 0;
let proxy: EgressProxy;
const lines = new Map([
  ['/control', 'HTTP/1.1 200 O\x01K'],
  ['/low', 'HTTP/1.1 099 Hi'],
  ['/fine', 'HTTP/1.1 200 OK'],
]);

beforeAll(async () => {
  upstream = createServer((socket) => {
    socket.once('data', (data) => {
      const path = /^GET (\S+)/.exec(data.toString())?.[1] ?? '';
      socket.end(`${lines.get(path)}\r\ncontent-length: 2\r\n\r\nok`);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as { port: number }).port;
  proxy = await startEgressProxy({ resolve: async () => ['127.0.0.1'], addressAllowed: () => true }, () => undefined);
});
afterAll(async () => {
  await proxy.close();
  upstream.close();
});

const through = (path: string) =>
  new Promise<number>((resolve, reject) => {
    const target = new URL(proxy.url);
    request({ host: target.hostname, port: target.port, path: `http://site.test:${port}${path}` }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });

describe('the egress proxy', () => {
  // the throw of writeHead was uncaught, and it ended the whole app (r8 probe).
  it('answers 502 to a status line that node reads but cannot send, and keeps running', async () => {
    expect(await through('/control')).toBe(502);
    expect(await through('/low')).toBe(502);
    expect(await through('/fine')).toBe(200);
  });
});

// the sandbox gives each call a proxy with the allowlist of the call (src/sandbox/network.ts).
describe('the allowHost option', () => {
  const egress = { resolve: async () => ['127.0.0.1'], addressAllowed: () => true };
  const refused: Array<{ target: string; reason: string }> = [];
  const passed: string[] = [];
  let gated: EgressProxy;
  beforeAll(async () => {
    gated = await startEgressProxy(
      egress,
      (target, reason) => refused.push({ target, reason }),
      (host) => passed.push(host),
      { allowHost: (host) => (host === 'site.test' ? undefined : `${host} is not in the allowlist`) },
    );
  });
  afterAll(() => gated.close());

  const plain = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const target = new URL(gated.url);
      request({ host: target.hostname, port: target.port, path: `http://${host}:${port}/fine` }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
  // the first line of the answer to a tunnel.
  const tunnel = (host: string) =>
    new Promise<string>((resolve, reject) => {
      const target = new URL(gated.url);
      const socket = connect(Number(target.port), target.hostname, () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
      socket.once('data', (data) => {
        resolve(data.toString().split('\r\n')[0]!);
        socket.destroy();
      });
      socket.on('error', reject);
    });

  it('refuses a plain request to a host that the check refuses, before the address check', async () => {
    expect(await plain('other.test')).toBe(403);
    expect(refused.at(-1)).toEqual({ target: `http://other.test:${port}/fine`, reason: 'other.test is not in the allowlist' });
    expect(await plain('site.test')).toBe(200);
    expect(passed).toContain('site.test');
  });

  it('refuses a tunnel to a host that the check refuses', async () => {
    expect(await tunnel('other.test')).toBe('HTTP/1.1 403 Forbidden');
    expect(refused.at(-1)).toEqual({ target: `other.test:${port}`, reason: 'other.test is not in the allowlist' });
    expect(await tunnel('site.test')).toBe('HTTP/1.1 200 Connection Established');
  });
});

// the proxy of a sandbox call asks for the credential of that call, so another local process cannot use it.
describe('the authorize option', () => {
  const egress = { resolve: async () => ['127.0.0.1'], addressAllowed: () => true };
  const refused: string[] = [];
  const seen: string[] = [];
  let site: Server;
  let sitePort = 0;
  let gated: EgressProxy;
  beforeAll(async () => {
    site = createServer((socket) => {
      socket.once('data', (data) => {
        seen.push(data.toString());
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
      });
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    sitePort = (site.address() as { port: number }).port;
    gated = await startEgressProxy(egress, (_target, reason) => refused.push(reason), undefined, {
      authorize: (header, host) => (header === 'Basic right' || host === 'free.test' ? undefined : 'no credential'),
    });
  });
  afterAll(async () => {
    await gated.close();
    site.close();
  });

  const plain = (auth?: string) =>
    new Promise<number>((resolve, reject) => {
      const target = new URL(gated.url);
      const headers = auth ? { 'proxy-authorization': auth } : {};
      request({ host: target.hostname, port: target.port, path: `http://site.test:${sitePort}/`, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
  const tunnel = (host: string, auth?: string) =>
    new Promise<string>((resolve, reject) => {
      const target = new URL(gated.url);
      const line = auth ? `Proxy-Authorization: ${auth}\r\n` : '';
      const socket = connect(Number(target.port), target.hostname, () => socket.write(`CONNECT ${host}:${sitePort} HTTP/1.1\r\n${line}\r\n`));
      socket.once('data', (data) => {
        resolve(data.toString().split('\r\n')[0]!);
        socket.destroy();
      });
      socket.on('error', reject);
    });

  it('answers 407 to a plain request without the credential, and keeps the credential from the host', async () => {
    expect(await plain()).toBe(407);
    expect(await plain('Basic wrong')).toBe(407);
    expect(refused).toEqual(['no credential', 'no credential']);
    expect(seen).toEqual([]);
    expect(await plain('Basic right')).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toLowerCase()).not.toContain('proxy-authorization');
  });

  it('answers 407 to a tunnel without the credential', async () => {
    expect(await tunnel('site.test')).toBe('HTTP/1.1 407 Proxy Authentication Required');
    expect(await tunnel('site.test', 'Basic right')).toBe('HTTP/1.1 200 Connection Established');
    // the check gets the host, so a caller can let one name through without a credential.
    expect(await tunnel('free.test')).toBe('HTTP/1.1 200 Connection Established');
  });
});

describe('the listen option', () => {
  const egress = { resolve: async () => ['127.0.0.1'], addressAllowed: () => true };

  it('listens on the loopback address by default', () => {
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  // the local network must not reach the proxy.
  it.each(['0.0.0.0', '::', '0:0::0', 'localhost', ''])('refuses to listen on %j', async (listen) => {
    await expect(startEgressProxy(egress, () => undefined, undefined, { listen })).rejects.toThrow(/proxy/);
  });

  const hasV6Loopback = Object.values(networkInterfaces())
    .flat()
    .some((each) => each?.address === '::1');
  it.skipIf(!hasV6Loopback)('puts an ipv6 address in brackets in the url', async () => {
    const v6 = await startEgressProxy(egress, () => undefined, undefined, { listen: '::1' });
    try {
      expect(v6.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    } finally {
      await v6.close();
    }
  });
});
