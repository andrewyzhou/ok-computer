import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { App } from '../app.js';
import type { Config } from '../config/schema.js';
import { estimateTokens } from '../context/tokens.js';
import type { Db } from '../db/index.js';
import { resolveMemoryPath } from '../memory/search.js';
import { createBlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { setChecklist } from '../scheduler/heartbeat.js';
import { getAutomation, updateAutomation } from '../scheduler/store.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import { createLogTail, isLevel, readLogs } from './logs.js';
import {
  automationRuns,
  automations,
  costPage,
  getBlob,
  getModelCallBody,
  getRunDetail,
  getToolCatalog,
  goalsPage,
  heartbeatStatus,
  listApprovals,
  listRuns,
  listSessions,
  overview,
  sessionEvents,
  toMcpMessage,
} from './queries.js';
import { integrationDetail, summaryOf } from './integrations.js';
import { createLocalSessions, LOGIN_PAGE, type LoginCodes } from './login.js';
import { createFeed } from './stream.js';
import type { ContextView, MemoryFile, Meta } from './types.js';

export interface DashboardDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  app: Pick<App, 'contextView' | 'resolveApproval' | 'scheduler' | 'integrations'>;
  // with a token, every api request must give it. the browser gives it in the query, because EventSource has no
  // headers.
  token?: string;
  // the codes that /dashboard sends. without them, only the token signs in.
  codes?: LoginCodes;
  pollMs?: number;
  webDir?: string;
}

const WEB_DIR = join(import.meta.dirname, '../../web/dist');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_COOKIE = 'okc_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

// the compare takes the same time for each wrong value of one length, so the time does not show the token.
function same(given: string | undefined, expected: string | undefined): boolean {
  if (given === undefined || expected === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// a login gives a code from /dashboard or the token. the body is json, so a form on another site cannot send it.
const loginBody = z.union([z.object({ code: z.string().min(1).max(64) }).strict(), z.object({ token: z.string().min(1).max(512) }).strict()]);
const enabledBody = z.object({ enabled: z.boolean() });
const checklistBody = z.object({ checklist: z.string().max(10_000) });
const decisionBody = z.object({ decision: z.enum(['approve', 'deny']) });
const pausedBody = z.object({ paused: z.boolean() });

export function createDashboard(deps: DashboardDeps): Hono {
  const { db, config, clock, logger, app } = deps;
  const tz = config.timeZone;
  const memoryDir = join(config.paths.data, 'memory');
  const logDir = join(config.paths.data, 'logs');
  const webDir = deps.webDir ?? WEB_DIR;
  const blobs = createBlobStore(db, join(config.paths.data, 'blobs'), clock);
  const server = new Hono();

  // the cookie of the public host holds a value derived from the token, not the token. a new token makes every old
  // cookie invalid. the browser sends it only to the public host, so it stays valid for 30 days and over a restart.
  const session = deps.token ? createHmac('sha256', deps.token).update('okc dashboard session').digest('hex') : undefined;
  const localSessions = createLocalSessions(clock);
  // tailscale serve forwards the requests of the tailnet name. that name is accepted only with a token, so the
  // dashboard is never open on the tailnet without one.
  const remoteHost = deps.token && config.dashboard.publicUrl ? new URL(config.dashboard.publicUrl).hostname : undefined;
  if (config.dashboard.publicUrl && !deps.token) logger.warn('dashboard.publicUrl is ignored, because DASHBOARD_TOKEN is not set');

  // a web page in the browser can send requests to a loopback port. the host check stops dns rebinding, and the
  // json check makes the browser ask for cors permission before a write, which this server never gives.
  server.use(async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!LOOPBACK.has(host) && host !== remoteHost) return c.text('forbidden', 403);
    if (c.req.path.startsWith('/api/')) {
      // the login is the one api request that comes before a sign-in. it checks its own code or token.
      const open = c.req.path === '/api/login';
      const given = c.req.header('authorization')?.replace(/^Bearer /, '') ?? c.req.query('token');
      const cookie = getCookie(c, SESSION_COOKIE);
      const signedIn = (given !== undefined && same(given, deps.token)) || (host === remoteHost && same(cookie, session)) || localSessions.valid(cookie);
      if (deps.token && !signedIn && !open) return c.json({ error: 'unauthorized' }, 401);
      const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
      if (write && !c.req.header('content-type')?.startsWith('application/json')) {
        return c.json({ error: 'send a json body' }, 415);
      }
    }
    await next();
  });

  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : undefined;
  };
  const notFound = (c: Context, what: string) => c.json({ error: `${what} not found` }, 404);

  // the owner signs in one time with a code or the token. the token then never goes into a url, a bookmark or the
  // history.
  server.get('/login', (c) => (session ? c.html(LOGIN_PAGE) : c.redirect('/')));
  server.post('/api/login', async (c) => {
    const given = await body(c, loginBody);
    const host = new URL(c.req.url).hostname;
    const valid = given !== undefined && ('code' in given ? deps.codes?.spend(given.code) === true : same(given.token, deps.token));
    if (!session || !given || !valid) {
      logger.warn('dashboard login refused', { host });
      return c.json({ error: 'that code or token does not work' }, 401);
    }
    // tailscale serve forwards plain http, so the public host or the forwarded protocol tells that the browser uses https.
    const https = host === remoteHost || c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
    // a cookie of a sign-in on the pc goes to every local port, so it is short and ends with the browser (see login.ts).
    const remote = host === remoteHost;
    setCookie(c, SESSION_COOKIE, remote ? session : localSessions.issue(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      ...(remote ? { maxAge: SESSION_SECONDS } : {}),
      secure: https,
    });
    logger.info('dashboard login', { host, via: 'code' in given ? 'code' : 'token' });
    return c.json({ ok: true });
  });

  server.get('/api/meta', (c) => c.json({ timeZone: tz, now: clock().toISOString() } satisfies Meta));
  server.get('/api/overview', (c) => c.json(overview(db, clock(), config)));

  server.get('/api/runs', (c) => {
    const query = c.req.query();
    const limit = Number(query.limit);
    return c.json(
      listRuns(
        db,
        {
          ...(query.trigger ? { trigger: query.trigger } : {}),
          ...(query.slot ? { slot: query.slot } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.day && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? { day: query.day } : {}),
          ...(limit > 0 ? { limit } : {}),
        },
        tz,
      ),
    );
  });
  server.get('/api/runs/:id', (c) => {
    const detail = getRunDetail(db, c.req.param('id'));
    return detail ? c.json(detail) : notFound(c, 'run');
  });
  server.get('/api/model-calls/:id', (c) => {
    const call = getModelCallBody(db, Number(c.req.param('id')));
    return call ? c.json(call) : notFound(c, 'model call');
  });

  server.get('/api/blobs/:hash', (c) => {
    try {
      const blob = getBlob(db, blobs.read, c.req.param('hash'));
      return blob ? c.json(blob) : notFound(c, 'blob');
    } catch (err) {
      // a damaged file is an error that the page shows. it never shows text that does not match the hash.
      return c.json({ error: (err as Error).message }, 500);
    }
  });
  server.get('/api/tool-catalogs/:hash', (c) => {
    const catalog = getToolCatalog(db, c.req.param('hash'));
    return catalog ? c.json(catalog) : notFound(c, 'tool catalog');
  });

  server.get('/api/sessions', (c) => c.json(listSessions(db)));
  server.get('/api/sessions/:key/events', (c) => c.json(sessionEvents(db, c.req.param('key'))));
  server.get('/api/sessions/:key/context', async (c) => {
    const request = await app.contextView(c.req.param('key'));
    return c.json({
      system: request.system,
      tools: request.tools.map(({ name, description }) => ({ name, description })),
      messages: request.messages,
      estimatedTokens: estimateTokens(request),
    } as ContextView);
  });

  server.get('/api/automations', (c) => c.json(automations(db, tz)));
  server.get('/api/automations/:id/runs', (c) => c.json(automationRuns(db, c.req.param('id'))));
  server.post('/api/automations/:id', async (c) => {
    const input = await body(c, enabledBody);
    if (!input) return c.json({ error: 'give enabled as true or false' }, 400);
    const result = updateAutomation(db, c.req.param('id'), { enabled: input.enabled }, clock(), tz);
    if (!result.ok) return c.json({ error: result.error }, 400);
    app.scheduler.replan();
    logger.info('dashboard changed an automation', { automationId: result.value.id, enabled: input.enabled });
    return c.json(automations(db, tz).find((automation) => automation.id === result.value.id));
  });
  // a run can take minutes, so the answer comes at once. the run shows in the stream when it starts and ends.
  server.post('/api/automations/:id/run', (c) => {
    const id = c.req.param('id');
    if (!getAutomation(db, id)) return notFound(c, 'automation');
    logger.info('dashboard runs an automation now', { automationId: id });
    void app.scheduler.runNow(id).catch((err: unknown) => logger.error('run now failed', { automationId: id, err }));
    return c.json({ started: true }, 202);
  });

  server.get('/api/heartbeat', (c) => c.json(heartbeatStatus(db, clock(), config)));
  server.put('/api/heartbeat/checklist', async (c) => {
    const input = await body(c, checklistBody);
    if (!input) return c.json({ error: 'give the checklist as text' }, 400);
    setChecklist(db, input.checklist, clock());
    logger.info('dashboard changed the heartbeat checklist');
    return c.json(heartbeatStatus(db, clock(), config));
  });

  server.get('/api/goals', (c) => c.json(goalsPage(db, clock(), tz)));

  server.get('/api/memory', (c) => c.json(memoryFiles(memoryDir)));
  server.get('/api/memory/file', (c) => {
    const full = resolveMemoryPath(memoryDir, c.req.query('path') ?? '');
    if (!full || !full.endsWith('.md') || !existsSync(full)) return notFound(c, 'file');
    return c.json({ path: c.req.query('path'), text: readFileSync(full, 'utf8') });
  });

  server.get('/api/approvals', (c) => c.json(listApprovals(db)));
  server.post('/api/approvals/:id', async (c) => {
    const input = await body(c, decisionBody);
    if (!input) return c.json({ error: 'give decision as approve or deny' }, 400);
    const message = await app.resolveApproval(Number(c.req.param('id')), input.decision, 'dashboard');
    return c.json({ message });
  });

  // the integrations page reads the live state of each server. the sign-in link opens on this pc only, because the
  // callback listens on loopback.
  const integration = (id: string) => app.integrations.status().find((each) => each.id === id);
  server.get('/api/integrations', (c) => c.json(app.integrations.status().map((status) => summaryOf(db, status, clock()))));
  server.get('/api/integrations/:id', (c) => {
    const status = integration(c.req.param('id'));
    return status ? c.json(integrationDetail(db, status, clock())) : notFound(c, 'integration');
  });
  // connect starts a new attempt. for a server that needs a sign-in, the answer has the link for the owner.
  server.post('/api/integrations/:id/connect', async (c) => {
    if (!integration(c.req.param('id'))) return notFound(c, 'integration');
    return c.json(await app.integrations.connect(c.req.param('id')));
  });
  server.post('/api/integrations/:id/pause', async (c) => {
    const input = await body(c, pausedBody);
    if (!input) return c.json({ error: 'give paused as true or false' }, 400);
    return (await app.integrations.setPaused(c.req.param('id'), input.paused)) ? c.json({ paused: input.paused }) : notFound(c, 'integration');
  });
  server.get('/api/mcp-messages/:id', (c) => {
    const row = db.prepare('SELECT * FROM mcp_messages WHERE id = ?').get(Number(c.req.param('id')));
    if (!row) return notFound(c, 'mcp message');
    const message = toMcpMessage(row);
    if (!message.payloadBlob) return c.json(message);
    try {
      return c.json({ ...message, payload: JSON.parse(blobs.read(message.payloadBlob) ?? 'null') });
    } catch (err) {
      return c.json({ error: `the payload of this message cannot be read: ${errorText(err)}` }, 500);
    }
  });

  server.get('/api/cost', (c) => c.json(costPage(db, clock(), tz)));

  server.get('/api/logs', (c) => {
    const level = c.req.query('level') ?? 'debug';
    const limit = Number(c.req.query('limit')) || 500;
    return c.json(readLogs(logDir, clock(), isLevel(level) ? level : 'debug', Math.min(limit, 5000)));
  });

  server.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const poll = createFeed(db, createLogTail(logDir, clock));
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted) {
        await stream.sleep(deps.pollMs ?? 1000);
        for (const message of poll()) await stream.writeSSE({ data: JSON.stringify(message) });
      }
    }),
  );

  server.all('/api/*', (c) => notFound(c, 'api route'));
  if (existsSync(join(webDir, 'index.html'))) {
    server.use('/*', serveStatic({ root: webDir }));
  } else {
    server.get('/', (c) => c.text('the dashboard is not built yet. run npm run build.'));
  }
  return server;
}

// the dashboard shows the daily notes, the weekly files, MEMORY.md and the consolidation log. it leaves out the
// backups in history/.
function memoryFiles(memoryDir: string): MemoryFile[] {
  if (!existsSync(memoryDir)) return [];
  const paths = readdirSync(memoryDir, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path.endsWith('.md') && !path.startsWith('history/'));
  const depth = (path: string) => path.split('/').length;
  return paths
    .sort((a, b) => depth(a) - depth(b) || b.localeCompare(a))
    .map((path) => {
      const stat = statSync(join(memoryDir, path));
      return { path, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

export interface RunningDashboard {
  port: number;
  close(): Promise<void>;
}

// the server listens on the loopback address only. other machines cannot connect.
export function startDashboard(deps: DashboardDeps & { port: number }): Promise<RunningDashboard> {
  const app = createDashboard(deps);
  return new Promise((resolve, reject) => {
    // by default the server puts its own Response class in place of the global one. a real fetch result then fails
    // `instanceof Response` in this process, and the mcp sdk misreads the error of a failed token refresh.
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: deps.port, overrideGlobalObjects: false }, (info) =>
      resolve({
        port: info.port,
        close: () =>
          new Promise((done) => {
            // an open event stream never ends by itself, so the close ends all connections.
            server.close(() => done());
            (server as Server).closeAllConnections();
          }),
      }),
    );
    server.once('error', reject);
  });
}
