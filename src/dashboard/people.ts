import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { normalizeEmail } from '../people/address.js';
import { InvalidCursor, InvalidMerge, PersonNotFound, peopleStore, type PeopleStore } from '../people/store.js';
import { limitOf } from './params.js';
import type { PeopleStatus } from './people-types.js';
import type { DashboardDeps } from './server.js';

// phase 6 t5 owns this module. it mounts the /api/people routes, and src/dashboard/people-types.ts gives their shapes.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth, and a write without a json
// body already got 415 there. the routes:
// - GET /api/people?q=&sort=&cursor=&limit= gives a PeoplePage.
// - GET /api/people/status gives the PeopleStatus.
// - GET /api/people/lookup?email= gives the PersonSummary of an address, for the person chip.
// - GET /api/people/:id gives a PersonProfile.
// - POST /api/people/:id/notes takes a PersonNoteInput and gives the new PersonNoteView, written by the owner.
// - POST /api/people/:id/merge takes a PersonMergeInput and merges that other person into this one, for one human that
//   shows as two people. it gives the PersonProfile of the person that stays.
// docs/API.md gives the errors. every read passes the clock of the dashboard as now, because the store splits the
// counts and the upcoming meetings at it. nothing here talks to google: the polls fill the store.
// store is the real store, and a test can give a fake.

const SORTS = ['recent', 'frequent', 'name'] as const;
const KINDS = ['note', 'preference'] as const;

const listQuery = z.object({
  q: z
    .string()
    .optional()
    .transform((raw) => raw?.trim() ?? '')
    .refine((q) => q.length <= 200, 'give q as text of at most 200 characters'),
  sort: z.enum(SORTS, { error: `give sort as one of: ${SORTS.join(', ')}` }).optional(),
  cursor: z.string().optional(),
  // a limit that is not a number gives the default, and a number is cut to the range, as section 1 of the contract says.
  limit: z
    .string()
    .optional()
    .transform((raw) => limitOf(raw, 200, 50)),
});

const mergeBody = z
  .object({
    otherId: z
      .number({ error: 'give otherId as the id of a person, a positive whole number' })
      .int('give otherId as the id of a person, a positive whole number')
      .positive('give otherId as the id of a person, a positive whole number'),
  })
  .strict();

const noteBody = z
  .object({
    kind: z.enum(KINDS, { error: `give kind as one of: ${KINDS.join(', ')}` }),
    text: z
      .string({ error: 'give text as text of 1 to 2000 characters' })
      .trim()
      .min(1, 'give text as text of 1 to 2000 characters')
      .max(2000, 'give text as text of 1 to 2000 characters'),
    supersedes: z
      .number({ error: 'give supersedes as the id of a note, a positive whole number' })
      .int('give supersedes as the id of a note, a positive whole number')
      .positive('give supersedes as the id of a note, a positive whole number')
      .optional(),
  })
  .strict();

// the first sentence that zod gives, which the page can show. a key that the schema does not know gets its own
// sentence, because the default text of zod is not one the page can show.
const firstError = (error: z.ZodError) => {
  const issue = error.issues[0];
  if (!issue) return 'the request is not valid';
  if (issue.code === 'unrecognized_keys') return `leave out ${issue.keys.join(', ')}, because this request does not take it`;
  return issue.message;
};

// a path id is a positive whole number. anything else names no person, so the route answers 404.
const idOf = (c: Context): number | undefined => {
  const raw = c.req.param('id') ?? '';
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
};

export function mountPeople(server: Hono, deps: DashboardDeps, store: PeopleStore = peopleStore): void {
  const { db, logger } = deps;
  const accounts = deps.config.google?.accounts.map((each) => each.alias) ?? [];
  const personNotFound = (c: Context) => c.json({ error: 'person not found' }, 404);

  server.get('/api/people', (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const { q, sort, cursor, limit } = parsed.data;
    try {
      return c.json(store.searchPeople(db, { ...(q ? { q } : {}), ...(sort ? { sort } : {}), ...(cursor !== undefined ? { cursor } : {}), limit }, deps.clock()));
    } catch (err) {
      if (err instanceof InvalidCursor) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // this route and /lookup come before /:id, so "status" and "lookup" are never read as an id.
  server.get('/api/people/status', (c) => {
    const status: PeopleStatus = {
      configured: Boolean(deps.config.google),
      people: store.countPeople(db),
      accounts: deps.config.google ? store.listBackfillStates(db, accounts) : [],
    };
    return c.json(status);
  });

  server.get('/api/people/lookup', (c) => {
    const raw = c.req.query('email');
    const email = raw === undefined ? null : normalizeEmail(raw);
    if (email === null) return c.json({ error: 'give email as one address' }, 400);
    const person = store.findPersonByEmail(db, email, deps.clock());
    return person ? c.json(person) : personNotFound(c);
  });

  server.get('/api/people/:id', (c) => {
    const id = idOf(c);
    const person = id === undefined ? undefined : store.getPerson(db, id, deps.clock());
    return person ? c.json(person) : personNotFound(c);
  });

  server.post('/api/people/:id/notes', async (c) => {
    const personId = idOf(c);
    if (personId === undefined) return personNotFound(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return c.json({ error: 'send a json object as the body' }, 400);
    const parsed = noteBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const { kind, text, supersedes } = parsed.data;
    try {
      const note = store.addNote(db, { personId, kind, text, author: 'owner', runId: null, toolCallId: null, ...(supersedes !== undefined ? { supersedes } : {}) }, deps.clock());
      // the text stays out of the log, because a note can hold private facts about the person.
      logger.info('dashboard added a person note', { personId });
      return c.json(note, 201);
    } catch (err) {
      if (!(err instanceof PersonNotFound)) throw err;
      // the store throws the same error for an unknown person and for a supersedes id that names no note of the
      // person. its message tells them apart.
      if (err.message === new PersonNotFound().message) return personNotFound(c);
      return c.json({ error: 'supersedes names no note of this person' }, 400);
    }
  });

  server.post('/api/people/:id/merge', async (c) => {
    const keepId = idOf(c);
    if (keepId === undefined) return personNotFound(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return c.json({ error: 'send a json object as the body' }, 400);
    const parsed = mergeBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const now = deps.clock();
    try {
      const kept = store.mergePeople(db, keepId, parsed.data.otherId, now);
      logger.info('dashboard merged two people', { personId: kept, otherId: parsed.data.otherId });
      const person = store.getPerson(db, kept, now);
      return person ? c.json(person) : personNotFound(c);
    } catch (err) {
      if (err instanceof PersonNotFound) return personNotFound(c);
      if (err instanceof InvalidMerge) return c.json({ error: 'give otherId as another person than this one' }, 400);
      throw err;
    }
  });
}
