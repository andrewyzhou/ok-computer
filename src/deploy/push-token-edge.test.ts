import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemorySecretStore } from '../integrations/secrets.js';
import { parsePushArgs, pushToken } from './push-token.js';

// these tests try to break npm run google:push: addresses that change where the token goes, a server that answers
// with something that is not the contract, and an alias that the config would refuse.

const REFRESH = 'refresh-token-of-the-desktop-edge-1234567890';
const SERVER_TOKEN = 'server-dashboard-token-edge-abcdefghijkl';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

// a local http server that records each request and answers with the handler.
async function listen(handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body?: string }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
      const answer = handler(req, body);
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const deps = () => ({ secrets: createMemorySecretStore({ 'google.personal': REFRESH }), clientId: CLIENT_ID, token: SERVER_TOKEN });

describe('parsePushArgs at its edges', () => {
  it('refuses each alias that the google block refuses', () => {
    for (const alias of ['Personal', '1st', '-a', 'a_b', 'a'.repeat(17), '', 'a b', 'personal/../school']) {
      expect(parsePushArgs([alias, '--to', 'https://okc.example.ts.net']), alias).toHaveProperty('error');
    }
    expect(parsePushArgs(['a'.repeat(16), '--to', 'https://okc.example.ts.net'])).toEqual({ alias: 'a'.repeat(16), to: 'https://okc.example.ts.net' });
  });

  it('refuses plain http to a host that only looks like loopback', () => {
    for (const to of ['http://127.0.0.1.nip.io', 'http://localhost.example.com', 'http://127.0.0.2', 'http://0.0.0.0', 'ftp://127.0.0.1', 'file:///etc/passwd', 'javascript:alert(1)', 'okc.example.ts.net']) {
      expect(parsePushArgs(['personal', '--to', to]), to).toHaveProperty('error');
    }
    for (const to of ['http://localhost:4317', 'http://[::1]:4317', 'http://127.0.0.1:4317']) {
      expect(parsePushArgs(['personal', '--to', to]), to).toEqual({ alias: 'personal', to });
    }
  });

  it('refuses a second --to in either form, and a --to with no value', () => {
    expect(parsePushArgs(['personal', '--to', 'https://a.ts.net', '--to=https://b.ts.net'])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--to=https://a.ts.net', '--to', 'https://b.ts.net'])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--to'])).toHaveProperty('error');
    expect(parsePushArgs(['personal', '--to='])).toHaveProperty('error');
  });
});

describe('pushToken against a real http server', () => {
  it('sends the token once, as json, with the server token in the header', async () => {
    const server = await listen(() => ({
      status: 200,
      body: JSON.stringify({ alias: 'personal', email: null, status: 'ok', scopes: [], storedAt: '2026-10-18T12:00:00.000Z' }),
    }));
    const answer = await pushToken({ alias: 'personal', to: server.url }, deps());
    expect(answer.email).toBeNull();
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ method: 'POST', url: '/api/google/accounts/personal/token', authorization: `Bearer ${SERVER_TOKEN}` });
    expect(JSON.parse(server.seen[0]!.body)).toEqual({ refreshToken: REFRESH, clientId: CLIENT_ID });
  });

  it('gives an error of the server without the token, even when the server quotes it', async () => {
    const server = await listen((_req, body) => ({ status: 503, body: JSON.stringify({ error: `the store refused ${body} with Bearer ${SERVER_TOKEN}` }) }));
    const err = (await pushToken({ alias: 'personal', to: server.url }, deps()).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^the server answered 503: /);
    expect(err.message).not.toContain(REFRESH);
    expect(err.message).not.toContain(SERVER_TOKEN);
  });

  it('a 200 that is not json fails without the token in the message', async () => {
    const server = await listen(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>a login page of a proxy</html>' }));
    const err = (await pushToken({ alias: 'personal', to: server.url }, deps()).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(REFRESH);
    expect(err.message).not.toContain(SERVER_TOKEN);
  });
});
