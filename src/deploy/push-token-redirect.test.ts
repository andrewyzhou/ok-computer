import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemorySecretStore } from '../integrations/secrets.js';
import { pushToken } from './push-token.js';

const REFRESH = 'refresh-token-of-the-desktop-fail-1234567890';
const SERVER_TOKEN = 'server-dashboard-token-fail-abcdefghijkl';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(handler: (req: IncomingMessage) => { status: number; headers?: Record<string, string>; body?: string }) {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(body);
      const answer = handler(req);
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const deps = () => ({ secrets: createMemorySecretStore({ 'google.personal': REFRESH }), clientId: CLIENT_ID, token: SERVER_TOKEN });

describe('google:push and redirects', () => {
  // a 307 or 308 makes fetch send the same body again to the new address, which can be plain http or another host.
  it('never sends the refresh token on to the address of a redirect', async () => {
    const other = await listen(() => ({ status: 200, body: '{}' }));
    const server = await listen(() => ({ status: 307, headers: { location: `${other.url}/stolen` } }));
    await pushToken({ alias: 'personal', to: server.url }, deps()).catch(() => undefined);
    expect(other.bodies.join('')).not.toContain(REFRESH);
  });
});
