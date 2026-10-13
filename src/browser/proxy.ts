import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { checkHost, type Egress } from '../web/egress.js';

export interface EgressProxy {
  // the address for --proxy-server.
  url: string;
  close(): Promise<void>;
}

// the page layers of the gate see only what chrome ties to a tab. a shared worker, a web socket of a dedicated worker
// and a preload of the speculation rules are not tied to one, so they reached the owner's network. chrome sends every
// connection through this proxy, which checks the address and then connects to that same address, so a name that
// resolves again to a private address (dns rebinding) does not get through either. the proxy knows only the host, not
// the tab, so the allowlist and the rule for sending data stay with the page layers.
export async function startEgressProxy(egress: Egress, onRefused: (target: string, reason: string) => void): Promise<EgressProxy> {
  // a plain http request comes with its full address.
  const server = createServer(async (req, res) => {
    const url = URL.parse(req.url ?? '');
    if (!url || url.protocol !== 'http:') return void res.writeHead(400).end();
    const host = await checkHost(egress, url.hostname);
    if (!host.ok) {
      onRefused(url.href, host.reason);
      return void res.writeHead(403).end();
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = request({ host: host.address, port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false });
    upstream.on('response', (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
      answer.pipe(res);
    });
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  // https and every web socket come as a tunnel to a host and a port.
  server.on('connect', async (req, client: Socket, head: Buffer) => {
    client.on('error', () => undefined);
    const target = URL.parse(`http://${req.url ?? ''}`);
    const host = target ? await checkHost(egress, target.hostname) : ({ ok: false, reason: 'the address is not valid' } as const);
    if (!target || !host.ok) {
      onRefused(req.url ?? '', host.ok ? 'the address is not valid' : host.reason);
      return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    const upstream = connect(Number(target.port || 443), host.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  // a tunnel leaves the http server, so the close ends each socket itself.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
