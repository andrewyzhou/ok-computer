import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { ACTIVE_STATUSES, DESK_CLOSED_LIMIT, DESK_STATUSES, DOC_REF_ERROR, isActive, LIMITS, LINK_KINDS, parseWhen, validDocRef, validEmail } from '../desk/shared.js';
import { createDelegation, getDelegation, getDelegationDetail, listDelegations, textMatch, updateDelegation, type DelegationPatch, type StoreResult } from '../desk/store.js';
import { addDays, localDay, zonedToUtc } from '../time.js';
import { errorText } from '../tools/registry.js';
import type { DashboardDeps } from './server.js';
import type { Delegation, DelegationLinkKind, DelegationStatus, DeskBoard, DeskColumn, DeskPerson, DeskQuery } from './desk-types.js';

// phase 6 t3 owns this module. it mounts the desk routes, and docs/API.md (T3) gives their shapes and errors:
// GET /api/desk, GET /api/desk/delegations/:id, POST /api/desk/delegations and POST /api/desk/delegations/:id.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth, and a write without a json
// body already got 415 there. the owner's edits go through the store, which writes the history row; they never send
// mail and never start a run.

const PERSON_CHARS = 320;
const ACCOUNT_CHARS = 100;
// a time is short text that parseWhen reads. the cap only keeps a huge string out of the parser.
const WHEN_CHARS = 100;

const NOT_FOUND = 'delegation not found';
const STATUS_ERROR = `use one of ${DESK_STATUSES.join(', ')}`;

// a text field of the body, trimmed, with its length in the sentence of the error.
const text = (field: string, max: number, min = 0) => {
  const message = min > 0 ? `give ${field} as text of ${min} to ${max} characters` : `give ${field} as text of at most ${max} characters`;
  return z.string({ error: message }).trim().min(min, message).max(max, message);
};
const when = (field: string) => z.string({ error: `give ${field} as a day or a time` }).max(WHEN_CHARS, `give ${field} as a day or a time`);
const status = z.enum(DESK_STATUSES as [DelegationStatus, ...DelegationStatus[]], { error: STATUS_ERROR });
const kind = z.enum(LINK_KINDS as [DelegationLinkKind, ...DelegationLinkKind[]], { error: `give the link kind as one of ${LINK_KINDS.join(', ')}` });

// a person needs a name or an email, and an email must be one plain address.
const waitingOn = z
  .object({ name: text('waitingOn.name', LIMITS.name).optional(), email: text('waitingOn.email', LIMITS.email).optional() }, { error: 'give waitingOn as an object with a name or an email' })
  .strict()
  .refine((value) => Boolean(value.name || value.email), 'give waitingOn a name or an email')
  .refine((value) => !value.email || validEmail(value.email), 'give waitingOn.email as one plain email address');

// a thread or an event belongs to a google account, so its link needs the account.
const link = z
  .object(
    {
      kind,
      ref: text('the link ref', LIMITS.ref, 1),
      account: text('the link account', ACCOUNT_CHARS, 1).optional(),
      label: text('the link label', LIMITS.label).optional(),
    },
    { error: 'give each link as an object with kind and ref' },
  )
  .strict()
  .refine((value) => (value.kind !== 'thread' && value.kind !== 'event') || Boolean(value.account), 'give a thread or an event link its google account')
  .refine((value) => value.kind !== 'doc' || validDocRef(value.ref), DOC_REF_ERROR);
// a link to remove takes any ref, so an old link with a bad ref can still go.
const removeLink = z
  .object({ kind, ref: text('the link ref', LIMITS.ref, 1), account: text('the link account', ACCOUNT_CHARS, 1).optional() }, { error: 'give each link as an object with kind and ref' })
  .strict();
const links = <T extends z.ZodType>(field: string, item: T) => z.array(item, { error: `give ${field} as a list` }).max(LIMITS.links, `give at most ${LIMITS.links} ${field}`);

const createBody = z
  .object(
    {
      title: text('title', LIMITS.title, 1),
      details: text('details', LIMITS.details).optional(),
      nextStep: text('nextStep', LIMITS.nextStep).optional(),
      waitingOn: waitingOn.optional(),
      dueAt: when('dueAt').optional(),
      nextFollowUpAt: when('nextFollowUpAt').optional(),
      links: links('links', link).optional(),
    },
    { error: 'send a json object as the body' },
  )
  .strict();

const updateBody = z
  .object(
    {
      title: text('title', LIMITS.title, 1).optional(),
      details: text('details', LIMITS.details).nullable().optional(),
      nextStep: text('nextStep', LIMITS.nextStep).nullable().optional(),
      status: status.optional(),
      waitingOn: waitingOn.nullable().optional(),
      dueAt: when('dueAt').nullable().optional(),
      nextFollowUpAt: when('nextFollowUpAt').nullable().optional(),
      addLinks: links('addLinks', link).optional(),
      removeLinks: links('removeLinks', removeLink).optional(),
      note: text('note', LIMITS.note, 1).optional(),
    },
    { error: 'send a json object as the body' },
  )
  .strict();

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
  return /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// parseDeskQuery reads the query of GET /api/desk. an empty value counts as a value, so a blank q is a 400 and not
// a silent board without the filter.
export function parseDeskQuery(query: Record<string, string | undefined>): Parsed<DeskQuery> {
  const value: DeskQuery = {};
  if (query.status !== undefined) {
    if (!DESK_STATUSES.includes(query.status as DelegationStatus)) return { ok: false, error: STATUS_ERROR };
    value.status = query.status as DelegationStatus;
  }
  if (query.person !== undefined) {
    const person = query.person.trim();
    if (!person || person.length > PERSON_CHARS) return { ok: false, error: `give person as a key of 1 to ${PERSON_CHARS} characters` };
    value.person = person;
  }
  if (query.q !== undefined) {
    const q = query.q.trim();
    if (!q || q.length > LIMITS.q) return { ok: false, error: `give q as text of 1 to ${LIMITS.q} characters` };
    value.q = q;
  }
  return { ok: true, value };
}

// the times of a body, read by parseWhen in the time zone of the app. undefined stays left out and null clears. a
// follow-up must come after now, because a time in the past would fire at once.
function timesOf(
  body: { dueAt?: string | null; nextFollowUpAt?: string | null },
  timeZone: string,
  now: Date,
): Parsed<{ dueAt?: string | null; nextFollowUpAt?: string | null }> {
  const out: { dueAt?: string | null; nextFollowUpAt?: string | null } = {};
  if (body.dueAt !== undefined) {
    if (body.dueAt === null) out.dueAt = null;
    else {
      const due = parseWhen(body.dueAt, timeZone, 'due');
      if (!due.ok) return due;
      out.dueAt = due.iso;
    }
  }
  if (body.nextFollowUpAt !== undefined) {
    if (body.nextFollowUpAt === null) out.nextFollowUpAt = null;
    else {
      const followUp = parseWhen(body.nextFollowUpAt, timeZone, 'followUp');
      if (!followUp.ok) return followUp;
      if (Date.parse(followUp.iso) <= now.getTime()) return { ok: false, error: 'the follow-up time is in the past' };
      out.nextFollowUpAt = followUp.iso;
    }
  }
  return { ok: true, value: out };
}

// the totals of each status for the filter, in one query. the where clause is the one of listDelegations, so a total
// counts the same rows that the column lists.
function countByStatus(db: Db, query: DeskQuery): Map<DelegationStatus, number> {
  const where: string[] = [];
  const params: string[] = [];
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.person) {
    where.push('waitingOnKey = ?');
    params.push(query.person);
  }
  if (query.q) {
    const match = textMatch(db, query.q);
    where.push(match.sql);
    params.push(...match.params);
  }
  const rows = db.prepare(`SELECT status, COUNT(*) AS total FROM delegations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY status`).all(...params);
  return new Map(rows.map((row) => [String(row.status) as DelegationStatus, Number(row.total)]));
}

// every person with an active delegation, without the filter. the name and the email come from the newest row of the
// key, so a later spelling wins.
function peopleOf(db: Db): DeskPerson[] {
  const rows = db
    .prepare(
      `SELECT id, waitingOnKey, waitingOnName, waitingOnEmail FROM delegations
       WHERE waitingOnKey IS NOT NULL AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')}) ORDER BY id`,
    )
    .all(...ACTIVE_STATUSES);
  const byKey = new Map<string, DeskPerson>();
  for (const row of rows) {
    const key = String(row.waitingOnKey);
    const name = row.waitingOnName === null ? null : String(row.waitingOnName);
    const email = row.waitingOnEmail === null ? null : String(row.waitingOnEmail);
    byKey.set(key, { key, name, email, active: (byKey.get(key)?.active ?? 0) + 1 });
  }
  const sortName = (person: DeskPerson) => (person.name ?? person.email ?? '').toLowerCase();
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byKey.values()].sort((a, b) => compare(sortName(a), sortName(b)) || compare(a.key, b.key));
}

// the active delegations that are due before the start of tomorrow in the time zone of the app, or whose follow-up
// time has passed. like people, it does not follow the filter, so the badge of the nav stays the same.
function dueTodayOf(db: Db, now: Date, timeZone: string): number {
  const tomorrow = zonedToUtc(addDays(localDay(now, timeZone), 1), '00:00', timeZone).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS due FROM delegations WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
         AND ((dueAt IS NOT NULL AND dueAt < ?) OR (nextFollowUpAt IS NOT NULL AND nextFollowUpAt <= ?))`,
    )
    .get(...ACTIVE_STATUSES, tomorrow, now.toISOString());
  return Number(row?.due ?? 0);
}

// deskBoard builds the answer of GET /api/desk. an active column holds every row of the filter, and a closed column
// holds the newest DESK_CLOSED_LIMIT of them.
export function deskBoard(db: Db, query: DeskQuery, now: Date, timeZone: string): DeskBoard {
  const totals = countByStatus(db, query);
  const columns: DeskColumn[] = DESK_STATUSES.map((each) => {
    if (query.status && query.status !== each) return { status: each, delegations: [], total: 0 };
    const delegations: Delegation[] = listDelegations(db, {
      statuses: [each],
      ...(query.person ? { person: query.person } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(isActive(each) ? {} : { limit: DESK_CLOSED_LIMIT }),
    });
    return { status: each, delegations, total: totals.get(each) ?? 0 };
  });
  const all = countByStatus(db, {});
  const counts = Object.fromEntries(DESK_STATUSES.map((each) => [each, all.get(each) ?? 0])) as Record<DelegationStatus, number>;
  return { columns, people: peopleOf(db), dueToday: dueTodayOf(db, now, timeZone), counts, timeZone };
}

export function mountDesk(server: Hono, deps: DashboardDeps): void {
  const { db, config, clock } = deps;
  const tz = config.timeZone;
  const notFound = (c: Context) => c.json({ error: NOT_FOUND }, 404);
  // a damaged row is an error that the page shows, not a crash of the request.
  const failed = (c: Context, err: unknown) => c.json({ error: errorText(err) }, 500);
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<Parsed<T>> => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) return { ok: false, error: 'send a json object as the body' };
    const parsed = schema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: firstError(parsed.error) };
  };
  // the store names the delegation in a 404. the route keeps the one sentence of the contract.
  const answer = (c: Context, result: StoreResult<Delegation>, created = false) => {
    if (result.ok) return c.json(result.value, created ? 201 : 200);
    return result.status === 404 ? notFound(c) : c.json({ error: result.error }, result.status);
  };

  server.get('/api/desk', (c) => {
    const parsed = parseDeskQuery(c.req.query());
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      return c.json(deskBoard(db, parsed.value, clock(), tz) satisfies DeskBoard);
    } catch (err) {
      return failed(c, err);
    }
  });

  server.get('/api/desk/delegations/:id', (c) => {
    const id = idOf(c);
    if (id === undefined) return notFound(c);
    try {
      const detail = getDelegationDetail(db, id);
      return detail ? c.json(detail) : notFound(c);
    } catch (err) {
      return failed(c, err);
    }
  });

  server.post('/api/desk/delegations', async (c) => {
    const parsed = await body(c, createBody);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const now = clock();
      const times = timesOf(parsed.value, tz, now);
      if (!times.ok) return c.json({ error: times.error }, 400);
      const { title, details, nextStep, waitingOn: person, links: given } = parsed.value;
      const result = createDelegation(
        db,
        {
          title,
          ...(details !== undefined ? { details } : {}),
          ...(nextStep !== undefined ? { nextStep } : {}),
          ...(person ? { waitingOn: person } : {}),
          ...times.value,
          ...(given ? { links: given } : {}),
          createdBy: 'owner',
        },
        { actor: 'owner' },
        now,
      );
      return answer(c, result, true);
    } catch (err) {
      return failed(c, err);
    }
  });

  server.post('/api/desk/delegations/:id', async (c) => {
    const id = idOf(c);
    if (id === undefined) return notFound(c);
    const parsed = await body(c, updateBody);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      if (!getDelegation(db, id)) return notFound(c);
      const now = clock();
      const times = timesOf(parsed.value, tz, now);
      if (!times.ok) return c.json({ error: times.error }, 400);
      // the times of the body are the text of the owner, so the patch takes the parsed ones in their place.
      const patch: DelegationPatch = { ...parsed.value, dueAt: undefined, nextFollowUpAt: undefined, ...times.value };
      return answer(c, updateDelegation(db, id, patch, { actor: 'owner' }, now));
    } catch (err) {
      return failed(c, err);
    }
  });
}
