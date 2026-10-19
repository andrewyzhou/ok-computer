import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { settleApprovals } from '../inbox/actions.js';
import type { ActionResult } from '../inbox/context.js';
import { inboxAutomation } from '../inbox/inbox.js';
import { getDigest, InvalidCursor, listDigests, listDrafts, listProposals, listSenders, listSubscriptions } from '../inbox/views.js';
import type { DashboardDeps } from './server.js';

// phase 5 m8 owns this module. it mounts the /api/inbox routes. docs/PHASE5-API.md gives the shapes and the errors.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth, and a write without a json
// body already got 415 there.

const SENDER_STATES = ['active', 'kept', 'unsubscribe_pending', 'unsubscribed', 'failed'] as const;
const SUBSCRIPTION_STATES = ['active', 'cancel_pending', 'cancelled', 'ignored'] as const;
const DRAFT_STATES = ['drafted', 'discarded', 'sent_by_owner'] as const;
const PROPOSAL_STATES = ['proposed', 'approved', 'created', 'declined', 'expired', 'failed'] as const;
const SORTS = ['messages', 'readRate', 'lastAt'] as const;
const JOBS = ['newsletters', 'subscriptions', 'digest'] as const;

// a limit that is not a number gives the default, and a number is cut to the range, as section 1 of the contract says.
const limit = (max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
      return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;
    });

const state = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values, { error: `give state as one of: ${values.join(', ')}` }).optional();
const before = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'give before as a positive whole number')
  .transform(Number)
  .optional();

// gmail keeps these labels for itself, so the archive cannot add one of them.
const RESERVED_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);
const reservedLabel = (label: string) => RESERVED_LABELS.has(label.toUpperCase()) || label.toUpperCase().startsWith('CATEGORY_');

const emptyBody = z.object({}).strict();
const archiveBody = z
  .object({
    olderThanDays: z.number({ error: 'give olderThanDays as a whole number from 0 to 3650' }).int('give olderThanDays as a whole number from 0 to 3650').min(0, 'give olderThanDays as a whole number from 0 to 3650').max(3650, 'give olderThanDays as a whole number from 0 to 3650').default(30),
    label: z
      .string({ error: 'give label as text of 1 to 100 characters' })
      .min(1, 'give label as text of 1 to 100 characters')
      .max(100, 'give label as text of 1 to 100 characters')
      .refine((label) => !/[\r\n]/.test(label), 'give label on one line, without a line break')
      .refine((label) => !reservedLabel(label), 'give a label of your own, not a gmail system label such as INBOX or SPAM')
      .optional(),
  })
  .strict();
const runBody = z.object({ job: z.enum(JOBS, { error: `give job as one of: ${JOBS.join(', ')}` }) }).strict();

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

export function mountInbox(server: Hono, deps: DashboardDeps): void {
  const { db, logger, app } = deps;
  const accounts = deps.config.google?.accounts.map((each) => each.alias) ?? [];
  const account = z
    .string()
    .optional()
    .refine((value) => value === undefined || accounts.includes(value), {
      error: accounts.length ? `give account as one of: ${accounts.join(', ')}` : 'no google account is set up, so leave out account',
    });

  const sendersQuery = z.object({ account, state: state(SENDER_STATES), sort: z.enum(SORTS, { error: `give sort as one of: ${SORTS.join(', ')}` }).optional(), cursor: z.string().optional(), limit: limit(200, 50) });
  const subscriptionsQuery = z.object({ account, state: state(SUBSCRIPTION_STATES) });
  const digestsQuery = z.object({ cursor: z.string().optional(), limit: limit(100, 30) });
  const draftsQuery = z.object({ account, state: state(DRAFT_STATES), before, limit: limit(200, 50) });
  const proposalsQuery = z.object({ account, state: state(PROPOSAL_STATES), before, limit: limit(200, 50) });

  const notFound = (c: Context, what: string) => c.json({ error: `${what} not found` }, 404);
  const query = <T>(c: Context, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; response: Response } => {
    const parsed = schema.safeParse(c.req.query());
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: c.json({ error: firstError(parsed.error) }, 400) };
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) return { ok: false, error: 'send a json object as the body' };
    const parsed = schema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: firstError(parsed.error) };
  };
  const answer = (c: Context, result: ActionResult) => (result.ok ? c.json(result.response) : c.json({ error: result.error }, result.status));
  const cursorError = (c: Context, err: unknown) => {
    if (err instanceof InvalidCursor) return c.json({ error: err.message }, 400);
    throw err;
  };

  server.get('/api/inbox/senders', (c) => {
    const parsed = query(c, sendersQuery);
    if (!parsed.ok) return parsed.response;
    // a denied or expired unsubscribe leaves the sender pending until something settles it.
    settleApprovals(db, deps.clock());
    const { account: alias, state: senderState, sort, cursor, limit: size } = parsed.value;
    try {
      return c.json(listSenders(db, { ...(alias ? { account: alias } : {}), ...(senderState ? { state: senderState } : {}), ...(sort ? { sort } : {}), ...(cursor !== undefined ? { cursor } : {}), limit: size }, accounts));
    } catch (err) {
      return cursorError(c, err);
    }
  });

  server.get('/api/inbox/subscriptions', (c) => {
    const parsed = query(c, subscriptionsQuery);
    if (!parsed.ok) return parsed.response;
    settleApprovals(db, deps.clock());
    const { account: alias, state: subscriptionState } = parsed.value;
    return c.json(listSubscriptions(db, { ...(alias ? { account: alias } : {}), ...(subscriptionState ? { state: subscriptionState } : {}) }));
  });

  server.get('/api/inbox/digests', (c) => {
    const parsed = query(c, digestsQuery);
    if (!parsed.ok) return parsed.response;
    try {
      return c.json(listDigests(db, { ...(parsed.value.cursor !== undefined ? { cursor: parsed.value.cursor } : {}), limit: parsed.value.limit }));
    } catch (err) {
      return cursorError(c, err);
    }
  });
  // this route comes before /:id, so "latest" is never read as an id.
  server.get('/api/inbox/digests/latest', (c) => {
    const digest = getDigest(db, 'latest');
    return digest ? c.json(digest) : notFound(c, 'digest');
  });
  server.get('/api/inbox/digests/:id', (c) => {
    const id = idOf(c);
    const digest = id === undefined ? undefined : getDigest(db, id);
    return digest ? c.json(digest) : notFound(c, 'digest');
  });

  server.get('/api/inbox/drafts', (c) => {
    const parsed = query(c, draftsQuery);
    if (!parsed.ok) return parsed.response;
    const { account: alias, state: draftState, before: id, limit: size } = parsed.value;
    return c.json(listDrafts(db, { ...(alias ? { account: alias } : {}), ...(draftState ? { state: draftState } : {}), ...(id !== undefined ? { before: id } : {}), limit: size }));
  });

  server.get('/api/inbox/proposals', (c) => {
    const parsed = query(c, proposalsQuery);
    if (!parsed.ok) return parsed.response;
    // a denied or expired approval declines or expires its proposal here.
    settleApprovals(db, deps.clock());
    const { account: alias, state: proposalState, before: id, limit: size } = parsed.value;
    return c.json(listProposals(db, { ...(alias ? { account: alias } : {}), ...(proposalState ? { state: proposalState } : {}), ...(id !== undefined ? { before: id } : {}), limit: size }));
  });

  // each action on a sender or a subscription. the inbox object exists only with a google block, so without it the
  // action cannot run, and the answer is 503. the inbox code answers 404 for an unknown row and 409 for a wrong state.
  const action = <T>(
    path: string,
    what: 'sender' | 'subscription',
    schema: z.ZodType<T>,
    run: (inbox: NonNullable<DashboardDeps['app']['inbox']>, id: number, input: T) => ActionResult | Promise<ActionResult>,
  ) =>
    server.post(path, async (c) => {
      const id = idOf(c);
      if (id === undefined) return notFound(c, what);
      const input = await body(c, schema);
      if (!input.ok) return c.json({ error: input.error }, 400);
      if (!app.inbox) return c.json({ error: 'the inbox jobs need the google integration' }, 503);
      logger.info('dashboard asked for an inbox action', { path: c.req.path });
      return answer(c, await run(app.inbox, id, input.value));
    });

  action('/api/inbox/senders/:id/unsubscribe', 'sender', emptyBody, (inbox, id) => inbox.unsubscribe(id));
  action('/api/inbox/senders/:id/archive', 'sender', archiveBody, (inbox, id, input) => inbox.archive(id, { olderThanDays: input.olderThanDays, ...(input.label !== undefined ? { label: input.label } : {}) }));
  action('/api/inbox/senders/:id/keep', 'sender', emptyBody, (inbox, id) => inbox.keep(id));
  action('/api/inbox/subscriptions/:id/cancel', 'subscription', emptyBody, (inbox, id) => inbox.cancel(id));
  action('/api/inbox/subscriptions/:id/ignore', 'subscription', emptyBody, (inbox, id) => inbox.ignore(id));

  // a job can take minutes, so the answer comes at once, as for POST /api/automations/:id/run. the scheduler runs the
  // automation, so the run shows in the stream and on the automations page like any other run.
  server.post('/api/inbox/run', async (c) => {
    const input = await body(c, runBody);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const automation = inboxAutomation(db, input.value.job);
    if (!automation) return notFound(c, 'inbox automation');
    logger.info('dashboard runs an inbox job now', { job: input.value.job, automationId: automation.id });
    void app.scheduler.runNow(automation.id).catch((err: unknown) => logger.error('run now failed', { automationId: automation.id, err }));
    return c.json({ started: true }, 202);
  });
}
