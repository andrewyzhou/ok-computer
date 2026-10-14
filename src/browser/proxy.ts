import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
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
// the tab, so the allowlist and the rule for sending data stay with the page layers. chrome can open a channel that no
// page layer sees, for example the socket of a worker, so onPassed gets each host that the proxy lets a connection reach.
export async function startEgressProxy(
  egress: Egress,
  onRefused: (target: string, reason: string) => void,
  onPassed: (host: string) => void = () => undefined,
): Promise<EgressProxy> {
  // a plain http request comes with its full address.
  // a throw in a handler is uncaught, and it ended the whole app (r8 probe), so each handler catches.
  const server = createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = URL.parse(req.url ?? '');
    if (!url || url.protocol !== 'http:') return void res.writeHead(400).end();
    const host = await checkHost(egress, url.hostname);
    if (!host.ok) {
      onRefused(url.href, host.reason);
      return void res.writeHead(403).end();
    }
    onPassed(url.hostname);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = request({ host: host.address, port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false });
    // a writeHead that throws keeps the reason that it refused, so the answer gives its own reason.
    const fail = () => (res.headersSent ? res.destroy() : res.writeHead(502, 'Bad Gateway', {}).end());
    upstream.on('response', (answer) => {
      // the parser of node reads a status line that writeHead refuses, for example a status below 100 or a control
      // character in the reason. a hostile server sent one, and the throw ended the app (r8 probe).
      try {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
      } catch {
        return void fail();
      }
      answer.pipe(res);
    });
    upstream.on('error', fail);
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  // https and every web socket come as a tunnel to a host and a port.
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => void tunnel(req, client, head).catch(() => client.destroy()));
  async function tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => undefined);
    const target = URL.parse(`http://${req.url ?? ''}`);
    const host = target ? await checkHost(egress, target.hostname) : ({ ok: false, reason: 'the address is not valid' } as const);
    if (!target || !host.ok) {
      onRefused(req.url ?? '', host.ok ? 'the address is not valid' : host.reason);
      return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    onPassed(target.hostname);
    const upstream = connect(Number(target.port || 443), host.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  }
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
