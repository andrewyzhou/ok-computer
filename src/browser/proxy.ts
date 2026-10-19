import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { checkHost, type Egress } from '../web/egress.js';

export interface EgressProxyOptions {
  // a check that runs before the address check, for example the allowlist of a sandbox call. it gives the reason of a
  // refusal, or undefined to go on.
  allowHost?: (host: string) => string | undefined;
  // the address that the proxy listens on. the default is the loopback address. it must be one address and never
  // 0.0.0.0 or ::, because the local network must not reach the proxy.
  listen?: string;
  // a check of the Proxy-Authorization header that runs before every other check. it gives the reason of a refusal,
  // and the proxy then answers 407, or undefined to go on. without it the proxy asks for no credential.
  authorize?: (authorization: string | undefined, host: string) => string | undefined;
}

// an unspecified address listens on every interface of this pc.
const everyInterface = (address: string) => (isIP(address) === 4 ? address === '0.0.0.0' : address.replace(/[:0]/g, '') === '');

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
  options: EgressProxyOptions = {},
): Promise<EgressProxy> {
  const listen = options.listen ?? '127.0.0.1';
  if (!isIP(listen)) throw new Error(`the proxy listens on an address, not on ${JSON.stringify(listen)}`);
  if (everyInterface(listen)) throw new Error(`the proxy must not listen on ${listen}, because the local network could then reach it`);
  const allowHost = options.allowHost ?? (() => undefined);
  const authorize = options.authorize ?? (() => undefined);
  // a plain http request comes with its full address.
  // a throw in a handler is uncaught, and it ended the whole app (r8 probe), so each handler catches.
  const server = createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = URL.parse(req.url ?? '');
    if (!url || url.protocol !== 'http:') return void res.writeHead(400).end();
    const unknown = authorize(req.headers['proxy-authorization'], url.hostname);
    if (unknown !== undefined) {
      onRefused(url.href, unknown);
      return void res.writeHead(407, { 'proxy-authenticate': 'Basic realm="okc"' }).end();
    }
    const refusal = allowHost(url.hostname);
    if (refusal !== undefined) {
      onRefused(url.href, refusal);
      return void res.writeHead(403).end();
    }
    const host = await checkHost(egress, url.hostname);
    if (!host.ok) {
      onRefused(url.href, host.reason);
      return void res.writeHead(403).end();
    }
    onPassed(url.hostname);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    // the credential is for this proxy, so it never goes on to the host.
    delete headers['proxy-authorization'];
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
    const unknown = authorize(req.headers['proxy-authorization'], target?.hostname ?? '');
    if (unknown !== undefined) {
      onRefused(req.url ?? '', unknown);
      return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="okc"\r\n\r\n');
    }
    const refusal = target ? allowHost(target.hostname) : undefined;
    if (refusal !== undefined) {
      onRefused(req.url ?? '', refusal);
      return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, listen, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://${isIP(listen) === 6 ? `[${listen}]` : listen}:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
