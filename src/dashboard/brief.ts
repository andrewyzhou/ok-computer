import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { briefSchedule, setBriefTime } from '../brief/install.js';
import { briefOfDay, getBrief, InvalidBriefCursor, listBriefs } from '../brief/store.js';
import { errorText } from '../tools/registry.js';
import { isDay, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';

// phase 6 t1 (the today track) owns this module. it mounts the /api/briefs and /api/brief routes of the today page.
// docs/API.md (t1) gives the shapes and the errors, and the types are in brief-types.ts. server.ts calls it after the
// sign-in check, so each route is behind the dashboard auth, and a write without a json body already got 415 there.

// a limit that is not a number gives the default, and a number is cut to the range, as section 1 of the contract says.
const limit = (max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => limitOf(raw, max, fallback));

const briefsQuery = z.object({ cursor: z.string().optional(), limit: limit(100, 30) });

const TIME_ERROR = 'give time as hh:mm, from 00:00 to 23:59';
const scheduleBody = z.object({ time: z.string({ error: TIME_ERROR }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, TIME_ERROR) }).strict();
const emptyBody = z.object({}).strict();

// the first sentence that zod gives, which the page can show. a key that the schema does not know gets its own
// sentence, because the default text of zod is not one the page can show.
const firstError = (error: z.ZodError) => {
  const issue = error.issues[0];
  if (!issue) return 'the request is not valid';
  if (issue.code === 'unrecognized_keys') return `leave out ${issue.keys.join(', ')}, because this request does not take it`;
  return issue.message;
};

// a path id is a positive whole number. anything else names no row, so the route answers 404.
const idOf = (c: Context): number | undefined => {
  const raw = c.req.param('id') ?? '';
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
};

export function mountBrief(server: Hono, deps: DashboardDeps): void {
  const { db, logger, app } = deps;
  const tz = deps.config.timeZone;

  const notFound = (c: Context) => c.json({ error: 'brief not found' }, 404);
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'send a json object as the body' };
    const parsed = schema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: firstError(parsed.error) };
  };

  server.get('/api/briefs', (c) => {
    const parsed = briefsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    try {
      return c.json(listBriefs(db, { ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}), limit: parsed.data.limit }));
    } catch (err) {
      if (err instanceof InvalidBriefCursor) return c.json({ error: 'give cursor as the nextCursor of the last page' }, 400);
      throw err;
    }
  });
  // these two routes come before /:id, so "latest" and "day" are never read as an id. a row whose content cannot be
  // read throws in the store, and onError of server.ts answers 500.
  server.get('/api/briefs/latest', (c) => {
    const brief = getBrief(db, 'latest');
    return brief ? c.json(brief) : notFound(c);
  });
  server.get('/api/briefs/day/:day', (c) => {
    const day = c.req.param('day');
    if (!isDay(day)) return c.json({ error: 'give day as yyyy-mm-dd' }, 400);
    const brief = briefOfDay(db, day);
    return brief ? c.json(brief) : notFound(c);
  });
  server.get('/api/briefs/:id', (c) => {
    const id = idOf(c);
    const brief = id === undefined ? undefined : getBrief(db, id);
    return brief ? c.json(brief) : notFound(c);
  });

  server.get('/api/brief/schedule', (c) => c.json(briefSchedule(db, tz, app.today.running())));
  server.put('/api/brief/schedule', async (c) => {
    const input = await body(c, scheduleBody);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const result = setBriefTime(db, input.value.time, deps.clock(), tz);
    if (!result.ok) return c.json({ error: result.error }, 400);
    app.scheduler.replan();
    logger.info('dashboard moved the brief', { time: input.value.time, automationId: result.value.automationId });
    return c.json({ ...result.value, running: app.today.running() });
  });

  // a brief can take a while, because it may wait for the digest of the day, so the answer comes at once, as for
  // POST /api/automations/:id/run. the brief job writes its own run and trace.
  server.post('/api/brief/run', async (c) => {
    const input = await body(c, emptyBody);
    if (!input.ok) return c.json({ error: input.error }, 400);
    if (app.today.running()) return c.json({ error: 'a brief is being built now' }, 409);
    logger.info('dashboard builds a brief now');
    void app.today.runBrief('dashboard').catch((err: unknown) => logger.error('the brief run failed', { error: errorText(err) }));
    return c.json({ started: true }, 202);
  });
}
