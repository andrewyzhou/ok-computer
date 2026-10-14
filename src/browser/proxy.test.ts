import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
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
