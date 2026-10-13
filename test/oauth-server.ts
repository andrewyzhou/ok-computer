import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createTestServer } from './mcp-server.js';

// a local authorization server and mcp server in one, for oauth tests. it acts like a strict real server:
// - pkce s256 is required, and a code works one time;
// - a refresh token works one time. a second use of a used refresh token revokes the whole family, as servers with
//   rotation and reuse detection do;
// - the owner's consent is a redirect at once, so a test plays the browser with one fetch.
export interface OAuthTestServer {
  base: string;
  close(): Promise<void>;
  // expire makes every access token invalid, so the next request gets a 401 and the client refreshes.
  expire(): void;
  revoke(): void;
  // refuseCodes makes the token endpoint refuse each authorization code, as for a consent that took too long.
  refuseCodes(): void;
  // down makes each refresh fail as a token endpoint that is down: a 503, or a connection that closes without an answer.
  // undefined ends the outage. refreshFailures counts the refreshes that failed.
  down(kind: 'network' | '503' | undefined): void;
  // requests counts every http request, so a test can show that a parked integration makes none.
  stats: { requests: number; authorizations: number; codeGrants: number; refreshGrants: number; reuse: number; mcpRequests: number; refreshFailures: number };
  // the client must give this client id. without it the test uses dynamic registration.
  clientId: string;
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');

export async function startOAuthServer(): Promise<OAuthTestServer> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Map<string, { used: boolean }>();
  let refusing = false;
  let outage: 'network' | '503' | undefined;
  const stats = { requests: 0, authorizations: 0, codeGrants: 0, refreshGrants: 0, reuse: 0, mcpRequests: 0, refreshFailures: 0 };
  const clientId = 'okc-test-client';
  let base = '';

  const issue = () => {
    const token = { access_token: `at_${b64url(randomBytes(12))}`, refresh_token: `rt_${b64url(randomBytes(12))}`, token_type: 'Bearer', expires_in: 3600 };
    access.add(token.access_token);
    refresh.set(token.refresh_token, { used: false });
    return token;
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };

  const mcp = async (req: IncomingMessage, res: ServerResponse, body: string) => {
    stats.mcpRequests++;
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token || !access.has(token)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      res.end();
      return;
    }
    const server = createTestServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    const response = await transport.handleRequest(
      new Request(`${base}${req.url}`, { method: req.method!, headers, ...(req.method === 'POST' ? { body } : {}) }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  };

  const server: Server = createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url!, base);
    const body = await readBody(req);
    if (url.pathname === '/mcp') return mcp(req, res, body);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      });
    }
    if (url.pathname === '/authorize') {
      stats.authorizations++;
      const redirect = url.searchParams.get('redirect_uri')!;
      if (url.searchParams.get('client_id') !== clientId || url.searchParams.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = b64url(randomBytes(12));
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('client_id') !== clientId) return json(res, 401, { error: 'invalid_client' });
      if (params.get('grant_type') === 'authorization_code') {
        const code = codes.get(params.get('code') ?? '');
        codes.delete(params.get('code') ?? '');
        const verifier = params.get('code_verifier') ?? '';
        if (refusing) return json(res, 400, { error: 'invalid_grant', error_description: 'the code expired' });
        if (!code || b64url(createHash('sha256').update(verifier).digest()) !== code.challenge) return json(res, 400, { error: 'invalid_grant' });
        stats.codeGrants++;
        return json(res, 200, issue());
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (outage) {
          stats.refreshFailures++;
          if (outage === 'network') return void res.socket?.destroy();
          res.writeHead(503, { 'content-type': 'text/plain' });
          return void res.end('upstream unavailable');
        }
        const token = refresh.get(params.get('refresh_token') ?? '');
        if (!token) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
        if (token.used) {
          stats.reuse++;
          // reuse detection: every token of the family stops working.
          access.clear();
          refresh.clear();
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token reuse' });
        }
        token.used = true;
        stats.refreshGrants++;
        // a slow token endpoint makes the race of two refreshes likely, as on a real network.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    stats,
    clientId,
    expire: () => access.clear(),
    revoke: () => {
      access.clear();
      refresh.clear();
    },
    refuseCodes: () => {
      refusing = true;
    },
    down: (kind) => {
      outage = kind;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
