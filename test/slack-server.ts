import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

// a fake of the official slack mcp server. the tool names and input fields copy the official server. the answer
// format is not documented, so the fake writes one plausible markdown form and one json form, and every fault that a
// test needs is a switch. startSlackOAuth puts the fake behind a sign-in that acts like slack:
// - the mcp origin publishes the metadata, and the sign-in and token endpoints are on another origin;
// - no dynamic registration: the client is a pre-registered app with a client secret;
// - the redirect must use https;
// - an error of the token endpoint comes with http 200 as { ok: false, error };
// - without rotation a token has no refresh token and no expiry. with rotation each refresh token works once.

export const SELF = 'U0OWNER0001';
export const ALICE = 'U0ALICE0001';
export const DM_ALICE = 'D0ALICE0001';
export const GROUP_DM = 'G0GROUP0001';
export const CHANNEL = 'C0GENERAL01';

export interface FakeMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
  // the unix time when the search index shows the message. the slack search index can be late.
  indexedAt?: number;
  // a file that the user shared in the conversation. the search gives it unless content_types leaves out files.
  file?: true;
}

export interface SlackFake {
  server(): Server;
  messages: FakeMessage[];
  sent: Array<{ channel_id: string; message: string }>;
  // the arguments of each search, and the name of each tool call.
  searches: Array<Record<string, unknown>>;
  calls: string[];
  faults: {
    format: 'markdown' | 'json' | 'garbage';
    // the search ignores sort_dir and gives the newest first.
    newestFirst: boolean;
    // the next n searches answer with a tool error, for example a rate limit.
    errors: number;
    // the search keeps every call waiting until the promise resolves.
    hold: Promise<void> | undefined;
  };
  // the time of the fake slack in unix seconds.
  now: () => number;
  // the time zone of the user. the search reads the day of after:<day> in it, and the profile answer names it.
  timeZone: string;
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required });
const kindOf = (channel: string) => (channel.startsWith('D') ? 'im' : channel.startsWith('G') ? 'mpim' : 'public_channel');

export function createSlackFake(now: () => number): SlackFake {
  const fake: SlackFake = {
    messages: [],
    sent: [],
    searches: [],
    calls: [],
    faults: { format: 'markdown', newestFirst: false, errors: 0, hold: undefined },
    now,
    timeZone: 'UTC',
    server() {
      const server = new Server({ name: 'slack-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({
        tools: [
          {
            name: 'slack_search_public_and_private',
            description: 'Searches for messages, files in all Slack channels, including DMs and group DMs. Require at least one of keywords or filters.',
            inputSchema: object({
              keywords: { type: 'array', items: { type: 'string' } },
              filters: { type: 'string' },
              channel_types: { type: 'string' },
              content_types: { type: 'string' },
              after: { type: 'string' },
              before: { type: 'string' },
              sort: { type: 'string', enum: ['score', 'timestamp'] },
              sort_dir: { type: 'string', enum: ['asc', 'desc'] },
              limit: { type: 'integer' },
              include_context: { type: 'boolean' },
              cursor: { type: 'string' },
            }),
            annotations: { readOnlyHint: true },
          },
          {
            name: 'slack_read_user_profile',
            description: 'Retrieves profile information for a Slack user. Defaults to the current user.',
            inputSchema: object({ user_id: { type: 'string' } }),
            annotations: { readOnlyHint: true },
          },
          {
            name: 'slack_read_channel',
            description: 'Reads messages from a Slack channel. To read DM history, use a user_id as channel_id.',
            inputSchema: object({ channel_id: { type: 'string' }, oldest: { type: 'string' }, limit: { type: 'integer' } }, ['channel_id']),
            annotations: { readOnlyHint: true },
          },
          {
            name: 'slack_read_thread',
            description: 'Reads the replies of a thread.',
            inputSchema: object({ channel_id: { type: 'string' }, message_ts: { type: 'string' } }, ['channel_id', 'message_ts']),
            annotations: { readOnlyHint: true },
          },
          {
            name: 'slack_send_message',
            description: 'Sends a message to a Slack channel or user. To DM a user, use their user_id as channel_id.',
            inputSchema: object({ channel_id: { type: 'string' }, message: { type: 'string' }, thread_ts: { type: 'string' } }, ['channel_id', 'message']),
          },
          {
            name: 'slack_schedule_message',
            description: 'Schedules a message for later.',
            inputSchema: object({ channel_id: { type: 'string' }, message: { type: 'string' }, post_at: { type: 'integer' } }, ['channel_id', 'message', 'post_at']),
          },
        ],
      }) as never);
      server.setRequestHandler('tools/call', async (request) => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        fake.calls.push(request.params.name);
        switch (request.params.name) {
          case 'slack_read_user_profile':
            return text(`## Profile\nName: Owner\nUser ID: ${SELF}\nTimezone: ${fake.timeZone}`);
          case 'slack_read_channel':
            return text(fake.messages.filter((m) => m.channel === args.channel_id).map((m) => `${m.user}: ${m.text}`).join('\n') || 'No messages.');
          case 'slack_read_thread':
            return text('No replies.');
          case 'slack_send_message':
            fake.sent.push({ channel_id: String(args.channel_id), message: String(args.message) });
            return text(`Message sent to ${String(args.channel_id)}.`);
          case 'slack_schedule_message':
            fake.sent.push({ channel_id: String(args.channel_id), message: String(args.message) });
            return text('Message scheduled.');
          case 'slack_search_public_and_private':
            return search(fake, args);
        }
        return text(`unknown tool ${request.params.name}`, true);
      });
      return server;
    },
  };
  return fake;
}

async function search(fake: SlackFake, args: Record<string, unknown>) {
  fake.searches.push(args);
  await fake.faults.hold;
  if (fake.faults.errors > 0) {
    fake.faults.errors--;
    return text('Error: ratelimited. Try again later.', true);
  }
  const filters = typeof args.filters === 'string' ? args.filters : '';
  const keywords = Array.isArray(args.keywords) ? (args.keywords as string[]) : [];
  if (!filters && !keywords.length) return text('Require at least one of keywords or filters.', true);
  if (fake.faults.format === 'garbage') return text('The search service has a new look! Your messages are in a widget now.');
  const types = String(args.channel_types ?? 'public_channel,private_channel,mpim,im').split(',');
  const contents = String(args.content_types ?? 'messages,files').split(',');
  // slack reads the day of after: in the time zone of the user, and gives only the later days.
  const afterDay = /after:(\d{4}-\d{2}-\d{2})/.exec(filters)?.[1];
  const after = Number(args.after ?? 0);
  const asc = args.sort === 'timestamp' && args.sort_dir === 'asc' && !fake.faults.newestFirst;
  const visible = fake.messages
    .filter(
      (m) =>
        types.includes(kindOf(m.channel)) &&
        contents.includes(m.file ? 'files' : 'messages') &&
        Number(m.ts) >= after &&
        (afterDay === undefined || new Date(Number(m.ts) * 1000).toLocaleDateString('en-CA', { timeZone: fake.timeZone }) > afterDay) &&
        (m.indexedAt ?? 0) <= fake.now() &&
        keywords.every((word) => m.text.toLowerCase().includes(word.toLowerCase())),
    )
    .sort((a, b) => (asc ? Number(a.ts) - Number(b.ts) : Number(b.ts) - Number(a.ts)))
    .slice(0, Math.min(Number(args.limit ?? 20), 20));
  if (fake.faults.format === 'json') {
    return text(JSON.stringify({ messages: visible.map((m) => ({ channel: { id: m.channel }, ts: m.ts, user: m.user, text: m.text })) }));
  }
  if (!visible.length) return text('No results found.');
  // the form of a file result is a guess. it has no message ts, so the reader cannot read it as a message.
  const blocks = visible.map((m, i) =>
    m.file
      ? `### Result ${i + 1} of ${visible.length}\nFile: ${m.text}\nChannel: DM (${m.channel})\nShared by: Someone (${m.user})\nCreated: ${m.ts.split('.')[0]}`
      : `### Result ${i + 1} of ${visible.length}\nChannel: ${kindOf(m.channel) === 'im' ? 'DM' : 'Group DM'} (${m.channel})\nFrom: Someone (${m.user})\nMessage_ts: ${m.ts}\nText:\n${m.text}`,
  );
  return text(`Found ${visible.length} results.\n\n${blocks.join('\n\n')}`);
}

export interface SlackOAuthServer {
  // the url of the mcp endpoint, as https://mcp.slack.com/mcp.
  url: string;
  clientId: string;
  clientSecret: string;
  // the scope of each authorize request, and the client auth of each token request.
  scopes: string[];
  tokenAuth: string[];
  stats: { mcpRequests: number; apiRequests: number; registrations: number; codeGrants: number; refreshGrants: number };
  // withhold names the scopes that a code grant leaves out, as a workspace admin can.
  options: { rotation: boolean; refreshError: string | undefined; withhold: string[] };
  // expire ends every access token, so the next call refreshes. revoke also ends every refresh token.
  expire(): void;
  revoke(): void;
  close(): Promise<void>;
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');

export async function startSlackOAuth(fake: SlackFake, options: Partial<SlackOAuthServer['options']> = {}): Promise<SlackOAuthServer> {
  const clientId = '1111111111.2222222222';
  const clientSecret = `cs${b64url(randomBytes(16))}`;
  const codes = new Map<string, { challenge: string; redirect: string; scope: string }>();
  const access = new Set<string>();
  // each refresh token and the scopes of its grant, which a refresh answer names again.
  const refresh = new Map<string, string>();
  const scopes: string[] = [];
  const tokenAuth: string[] = [];
  const stats = { mcpRequests: 0, apiRequests: 0, registrations: 0, codeGrants: 0, refreshGrants: 0 };
  const settings: SlackOAuthServer['options'] = { rotation: false, refreshError: undefined, withhold: [], ...options };
  let mcpBase = '';
  let apiBase = '';

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: ServerResponse, error: string) => json(res, 200, { ok: false, error });
  const issue = (scope: string) => {
    const token = `xoxp-${b64url(randomBytes(16))}`;
    access.add(token);
    if (!settings.rotation) return { ok: true, app_id: 'A0FAKE', authed_user: { id: SELF }, team: { id: 'T0ACME01' }, scope, access_token: token, token_type: 'user' };
    const refreshToken = `xoxe-1-${b64url(randomBytes(16))}`;
    refresh.set(refreshToken, scope);
    return { ok: true, scope, access_token: token, refresh_token: refreshToken, expires_in: 43_200, token_type: 'user' };
  };
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const listen = async (server: HttpServer) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  // mcp.slack.com: the metadata and the mcp endpoint.
  const mcp = createServer(async (req, res) => {
    stats.mcpRequests++;
    const url = new URL(req.url!, mcpBase);
    const body = await readBody(req);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      // the metadata offers more scopes than an owner wants to give.
      return json(res, 200, {
        resource: `${mcpBase}/mcp`,
        authorization_servers: [mcpBase],
        scopes_supported: ['search:read.public', 'search:read.private', 'search:read.im', 'search:read.mpim', 'chat:write', 'im:history', 'canvases:write', 'users:read.email'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: mcpBase,
        authorization_endpoint: `${apiBase}/oauth/v2_user/authorize`,
        token_endpoint: `${apiBase}/api/oauth.v2.user.access`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/register') {
      stats.registrations++;
      return void res.writeHead(404).end();
    }
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token || !access.has(token)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcpBase}/.well-known/oauth-protected-resource/mcp"` });
      return void res.end();
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await fake.server().connect(transport);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    const response = await transport.handleRequest(new Request(`${mcpBase}${req.url}`, { method: req.method!, headers, ...(req.method === 'POST' ? { body } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  // slack.com: the consent page and the token method.
  const api = createServer(async (req, res) => {
    stats.apiRequests++;
    const url = new URL(req.url!, apiBase);
    const body = await readBody(req);
    if (url.pathname === '/oauth/v2_user/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (url.searchParams.get('client_id') !== clientId) return void res.writeHead(400).end('invalid_client_id');
      if (!redirect.startsWith('https://')) return void res.writeHead(400).end('bad_redirect_uri: the redirect must use https');
      scopes.push(url.searchParams.get('scope') ?? '');
      const code = b64url(randomBytes(12));
      codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect, scope: url.searchParams.get('scope') ?? '' });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return void res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === '/api/oauth.v2.user.access') {
      const params = new URLSearchParams(body);
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : undefined;
      tokenAuth.push(basic ? 'basic' : params.get('client_secret') ? 'post' : 'none');
      const [id, secret] = basic ? basic.split(':').map(decodeURIComponent) : [params.get('client_id'), params.get('client_secret')];
      if (id !== clientId) return refuse(res, 'invalid_client_id');
      if (secret !== clientSecret) return refuse(res, 'bad_client_secret');
      if (params.get('grant_type') === 'authorization_code') {
        const code = codes.get(params.get('code') ?? '');
        codes.delete(params.get('code') ?? '');
        const verifier = params.get('code_verifier') ?? '';
        if (!code || code.redirect !== params.get('redirect_uri') || b64url(createHash('sha256').update(verifier).digest()) !== code.challenge) {
          return refuse(res, 'invalid_code');
        }
        stats.codeGrants++;
        return json(res, 200, issue(code.scope.split(' ').filter((scope) => !settings.withhold.includes(scope)).join(',')));
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (settings.refreshError) return refuse(res, settings.refreshError);
        const scope = refresh.get(params.get('refresh_token') ?? '');
        if (scope === undefined) return refuse(res, 'invalid_refresh_token');
        refresh.delete(params.get('refresh_token') ?? '');
        stats.refreshGrants++;
        return json(res, 200, issue(scope));
      }
      return refuse(res, 'unsupported_grant_type');
    }
    res.writeHead(404).end();
  });

  mcpBase = await listen(mcp);
  apiBase = await listen(api);
  return {
    url: `${mcpBase}/mcp`,
    clientId,
    clientSecret,
    scopes,
    tokenAuth,
    stats,
    options: settings,
    expire: () => access.clear(),
    revoke: () => {
      access.clear();
      refresh.clear();
    },
    close: async () => {
      await new Promise<void>((resolve) => mcp.close(() => resolve()));
      await new Promise<void>((resolve) => api.close(() => resolve()));
    },
  };
}
