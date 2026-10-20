import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeoplePage, PeopleStatus, PersonNoteView, PersonProfile, PersonSummary } from '../src/dashboard/people-types.js';
import { mountPeople } from '../src/dashboard/people.js';
import { createDashboard, type DashboardDeps } from '../src/dashboard/server.js';
import type { Db } from '../src/db/index.js';
import { googleConfigSchema } from '../src/google/config.js';
import { createLogger, type Logger } from '../src/observability/logger.js';
import { InvalidCursor, PersonNotFound, peopleStore, type NoteInput, type PeopleStore, type SearchInput } from '../src/people/store.js';
import { createTestApp } from './app-harness.js';
import { PEOPLE_ACCOUNTS, PEOPLE_NOW, seedPeople } from './seed-people.js';

// the people routes on the seeded database of test/seed-people.ts, with the clock at PEOPLE_NOW. the profiles must
// equal the fixtures of the web view, which keeps the fixtures honest.
//
// the store of the people memory is not built on this branch yet, so the routes get a fake store, mounted on a plain
// hono server as server.ts mounts them. the fake answers from the fixtures and keeps the notes in memory. when the
// real store lands, build() mounts with peopleStore through createDashboard, and every test below stays the same.

interface FakeNote extends PersonNoteView {
  personId: number;
  supersedes: number | null;
}

interface FakeStore extends PeopleStore {
  // every now that a read or a write got, so a test can see that the routes pass the clock of the dashboard.
  nows: Date[];
  notesAdded: NoteInput[];
}

// the fixtures live in the web project, whose imports leave out the .js ending that the node typecheck needs. a path
// that tsc does not follow keeps that file out of the node typecheck, and the web typecheck still covers it.
interface Fixtures {
  maya: PersonSummary;
  tomas: PersonSummary;
  priya: PersonSummary;
  noName: PersonSummary;
  jonas: PersonSummary;
  mayaProfile: PersonProfile;
  tomasProfile: PersonProfile;
  statusDone: PeopleStatus;
}
const fixturesPath: string = '../web/src/views/people/fixtures.ts';
const { jonas, maya, mayaProfile, noName, priya, statusDone, tomas, tomasProfile } = (await import(fixturesPath)) as Fixtures;

const summaries = [maya, tomas, priya, noName, jonas];
const bareProfile = (summary: PersonSummary): PersonProfile => ({
  ...summary,
  names: [],
  emailDetails: [],
  upcoming: [],
  recentMeetings: [],
  openThreads: [],
  notes: [],
  preferences: [],
  delegations: [],
});

function fakeStore(): FakeStore {
  const nows: Date[] = [];
  const notesAdded: NoteInput[] = [];
  // the notes of the seed, with note 1 superseded by note 3.
  const notes: FakeNote[] = [
    { id: 1, personId: 1, kind: 'preference', text: 'prefers morning meetings', author: 'agent', runId: 'run-people-1', createdAt: '2026-10-01T16:00:00.000Z', supersedes: null },
    ...mayaProfile.notes.map((note) => ({ ...note, personId: 1, supersedes: null })),
    ...mayaProfile.preferences.map((note) => ({ ...note, personId: 1, supersedes: 1 })),
    ...tomasProfile.notes.map((note) => ({ ...note, personId: 2, supersedes: null })),
  ];
  const profiles = new Map<number, PersonProfile>([
    [1, mayaProfile],
    [2, tomasProfile],
    [3, bareProfile(priya)],
    [4, bareProfile(noName)],
    [5, bareProfile(jonas)],
  ]);
  const view = ({ id, kind, text, author, runId, createdAt }: FakeNote): PersonNoteView => ({ id, kind, text, author, runId, createdAt });
  const shown = (personId: number, kind: FakeNote['kind']) =>
    notes
      .filter((note) => note.personId === personId && note.kind === kind && !notes.some((later) => later.supersedes === note.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .map(view);
  const words = (summary: PersonSummary) => [summary.displayName, ...(profiles.get(summary.id)?.names.map((name) => name.name) ?? []), ...summary.emails, summary.organization ?? ''].map((word) => word.toLowerCase());
  const order = (sort: SearchInput['sort']) => (a: PersonSummary, b: PersonSummary) => {
    if (sort === 'frequent') return b.mailCount + b.meetingCount - (a.mailCount + a.meetingCount) || a.id - b.id;
    if (sort === 'name') return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.id - b.id;
    if (a.lastContactAt === b.lastContactAt) return a.id - b.id;
    if (a.lastContactAt === null) return 1;
    if (b.lastContactAt === null) return -1;
    return b.lastContactAt.localeCompare(a.lastContactAt) || a.id - b.id;
  };

  return {
    ...peopleStore,
    nows,
    notesAdded,
    searchPeople(_db: Db, input: SearchInput, now: Date): PeoplePage {
      nows.push(now);
      let offset = 0;
      if (input.cursor !== undefined) {
        const match = /^at:(\d+)$/.exec(Buffer.from(input.cursor, 'base64url').toString());
        if (!match) throw new InvalidCursor();
        offset = Number(match[1]);
      }
      const q = input.q?.toLowerCase() ?? '';
      const matched = summaries.filter((summary) => words(summary).some((word) => word.includes(q))).sort(order(input.sort));
      const end = offset + input.limit;
      return { people: matched.slice(offset, end), next: end < matched.length ? Buffer.from(`at:${end}`).toString('base64url') : null, total: matched.length };
    },
    getPerson(_db: Db, id: number, now: Date) {
      nows.push(now);
      const profile = profiles.get(id);
      return profile && { ...profile, notes: shown(id, 'note'), preferences: shown(id, 'preference') };
    },
    findPersonByEmail(_db: Db, email: string, now: Date) {
      nows.push(now);
      return summaries.find((summary) => summary.emails.includes(email.trim().toLowerCase()));
    },
    addNote(_db: Db, input: NoteInput, now: Date): PersonNoteView {
      nows.push(now);
      if (!profiles.has(input.personId)) throw new PersonNotFound();
      if (input.supersedes !== undefined && !notes.some((note) => note.id === input.supersedes && note.personId === input.personId)) throw new PersonNotFound('note');
      notesAdded.push(input);
      const note: FakeNote = {
        id: Math.max(...notes.map((each) => each.id)) + 1,
        personId: input.personId,
        kind: input.kind,
        text: input.text.trim(),
        author: input.author,
        runId: input.runId ?? null,
        createdAt: now.toISOString(),
        supersedes: input.supersedes ?? null,
      };
      notes.push(note);
      return view(note);
    },
    // the status reads the seeded tables, as the real store does.
    countPeople: (db: Db) => (db.prepare('SELECT count(*) AS n FROM people').get() as { n: number }).n,
    listBackfillStates: (db: Db, accounts: readonly string[]) =>
      accounts.map((account) => {
        const row = db.prepare('SELECT backfill, backfillMessages, backfillEvents, backfilledAt, error FROM people_accounts WHERE account = ?').get(account) as
          | Omit<PeopleStatus['accounts'][number], 'account'>
          | undefined;
        return { account, ...(row ?? { backfill: 'pending' as const, backfillMessages: 0, backfillEvents: 0, backfilledAt: null, error: null }) };
      }),
  };
}

interface Logged {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

// a logger that keeps each info line, so a test can see that a note's text never reaches the log.
function recordingLogger(lines: Logged[]): Logger {
  const silent = createLogger({ consoleLevel: 'off' });
  return { ...silent, info: (msg, fields) => void lines.push({ msg, fields }), child: () => recordingLogger(lines) };
}

let closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers) close();
  closers = [];
});

function build(options: { google?: boolean; token?: string; full?: boolean } = {}) {
  const t = createTestApp([], { start: PEOPLE_NOW.toISOString() });
  closers.push(() => t.db.close());
  seedPeople(t.db);
  const google = googleConfigSchema.parse({ clientId: 'seed.apps.googleusercontent.com', accounts: PEOPLE_ACCOUNTS.map((alias) => ({ alias })) });
  const logged: Logged[] = [];
  const deps: DashboardDeps = {
    db: t.db,
    config: options.google === false ? t.config : { ...t.config, google },
    clock: () => PEOPLE_NOW,
    logger: recordingLogger(logged),
    app: t.app,
    ...(options.token ? { token: options.token } : {}),
  };
  const store = fakeStore();
  // full gives the whole dashboard with its sign-in and json checks, which come before the store.
  let dashboard: Hono;
  if (options.full) {
    dashboard = createDashboard(deps);
  } else {
    dashboard = new Hono();
    mountPeople(dashboard, deps, store);
  }
  return { dashboard, store, logged, db: t.db };
}

type Dashboard = ReturnType<typeof build>['dashboard'];

const post = (dashboard: Dashboard, path: string, body: unknown) =>
  dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

async function error(response: Response | Promise<Response>, status: number): Promise<string> {
  const answer = await response;
  expect(answer.status).toBe(status);
  const body = (await answer.json()) as { error: string };
  expect(Object.keys(body)).toEqual(['error']);
  return body.error;
}

const ids = (page: PeoplePage) => page.people.map((person) => person.id);

describe('the people list', () => {
  it('lists everyone by the last contact, with a person without past contact last', async () => {
    const { dashboard, store } = build();
    const page = await get<PeoplePage>(dashboard, '/api/people');
    expect(ids(page)).toEqual([1, 2, 3, 4, 5]);
    expect(page).toMatchObject({ total: 5, next: null });
    expect(page.people[0]).toEqual(maya);
    expect(store.nows).toEqual([PEOPLE_NOW]);
  });

  it('searches names, emails and organizations without case', async () => {
    const { dashboard } = build();
    expect(ids(await get<PeoplePage>(dashboard, '/api/people?q=northwind'))).toEqual([1]);
    const gmail = await get<PeoplePage>(dashboard, '/api/people?q=GMAIL');
    expect(ids(gmail)).toEqual([1, 2]);
    expect(gmail.total).toBe(2);
    // q is trimmed, and a blank q lists everyone.
    expect(ids(await get<PeoplePage>(dashboard, '/api/people?q=%20%20tomas%20'))).toEqual([2]);
    expect((await get<PeoplePage>(dashboard, '/api/people?q=%20%20')).total).toBe(5);
    expect(await get<PeoplePage>(dashboard, '/api/people?q=nobody')).toEqual({ people: [], next: null, total: 0 });
  });

  it('sorts by name and by frequency', async () => {
    const { dashboard } = build();
    expect(ids(await get<PeoplePage>(dashboard, '/api/people?sort=name'))).toEqual([5, 4, 1, 3, 2]);
    // maya has four contacts, and the three people with two tie, so the id breaks the tie.
    expect(ids(await get<PeoplePage>(dashboard, '/api/people?sort=frequent'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('pages through next to the end', async () => {
    const { dashboard } = build();
    const seen: number[] = [];
    let path = '/api/people?limit=2';
    for (;;) {
      const page = await get<PeoplePage>(dashboard, path);
      expect(page.total).toBe(5);
      expect(page.people.length).toBeLessThanOrEqual(2);
      seen.push(...ids(page));
      if (page.next === null) break;
      path = `/api/people?limit=2&cursor=${encodeURIComponent(page.next)}`;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('clamps the limit, and a limit that is not a number gives the default', async () => {
    const { dashboard } = build();
    expect(ids(await get<PeoplePage>(dashboard, '/api/people?limit=0'))).toEqual([1]);
    expect((await get<PeoplePage>(dashboard, '/api/people?limit=9999')).next).toBeNull();
    expect((await get<PeoplePage>(dashboard, '/api/people?limit=many')).people).toHaveLength(5);
  });

  it('refuses a bad sort, a long q and a bad cursor', async () => {
    const { dashboard } = build();
    expect(await error(dashboard.request('/api/people?sort=age'), 400)).toBe('give sort as one of: recent, frequent, name');
    expect(await error(dashboard.request(`/api/people?q=${'a'.repeat(201)}`), 400)).toBe('give q as text of at most 200 characters');
    // 200 characters with spaces around them is still a q of 200 characters.
    expect((await get<PeoplePage>(dashboard, `/api/people?q=%20${'a'.repeat(200)}%20`)).total).toBe(0);
    expect(await error(dashboard.request('/api/people?cursor=garbage'), 400)).toBe('the cursor is not valid');
  });
});

describe('the people status', () => {
  it('gives the backfill of each google account', async () => {
    const { dashboard } = build();
    expect(await get<PeopleStatus>(dashboard, '/api/people/status')).toEqual(statusDone);
  });

  it('says when no google account is set up', async () => {
    const { dashboard } = build({ google: false });
    expect(await get<PeopleStatus>(dashboard, '/api/people/status')).toEqual({ configured: false, people: 5, accounts: [] });
  });
});

describe('the lookup of an address', () => {
  it('finds a person by any address, without case', async () => {
    const { dashboard, store } = build();
    expect(await get<PersonSummary>(dashboard, '/api/people/lookup?email=Maya.Lindqvist%40GMAIL.com')).toEqual(maya);
    expect(await get<PersonSummary>(dashboard, '/api/people/lookup?email=%3Cmaya%40northwind.example%3E')).toEqual(maya);
    expect(store.nows.every((now) => now === PEOPLE_NOW)).toBe(true);
  });

  it('gives 404 for an unknown address and 400 for one that is not an address', async () => {
    const { dashboard } = build();
    expect(await error(dashboard.request('/api/people/lookup?email=nobody%40example.com'), 404)).toBe('person not found');
    expect(await error(dashboard.request('/api/people/lookup?email=not-an-address'), 400)).toBe('give email as one address');
    expect(await error(dashboard.request('/api/people/lookup?email=a%40b.example,c%40d.example'), 400)).toBe('give email as one address');
    expect(await error(dashboard.request('/api/people/lookup'), 400)).toBe('give email as one address');
  });
});

describe('the profile', () => {
  it('equals the fixtures of the web view', async () => {
    const { dashboard, store } = build();
    expect(await get<PersonProfile>(dashboard, '/api/people/1')).toEqual(mayaProfile);
    expect(await get<PersonProfile>(dashboard, '/api/people/2')).toEqual(tomasProfile);
    expect(store.nows).toEqual([PEOPLE_NOW, PEOPLE_NOW]);
  });

  it('gives 404 for an id that is not a number and for an unknown id', async () => {
    const { dashboard } = build();
    for (const path of ['/api/people/abc', '/api/people/999', '/api/people/0', '/api/people/01', '/api/people/1.5', `/api/people/${'9'.repeat(17)}`]) {
      expect(await error(dashboard.request(path), 404), path).toBe('person not found');
    }
  });
});

describe('the notes of a person', () => {
  it('adds an owner note that then shows in the profile', async () => {
    const { dashboard, store, logged } = build();
    const response = await post(dashboard, '/api/people/2/notes', { kind: 'note', text: '  lease signed on friday  ' });
    expect(response.status).toBe(201);
    const note = (await response.json()) as PersonNoteView;
    expect(note).toEqual({ id: 5, kind: 'note', text: 'lease signed on friday', author: 'owner', runId: null, createdAt: PEOPLE_NOW.toISOString() });
    expect(store.notesAdded).toEqual([{ personId: 2, kind: 'note', text: 'lease signed on friday', author: 'owner', runId: null, toolCallId: null }]);
    expect(store.nows).toEqual([PEOPLE_NOW]);

    const profile = await get<PersonProfile>(dashboard, '/api/people/2');
    expect(profile.notes.map((each) => each.id)).toEqual([5, 4]);
    // the log names the person and never the text.
    expect(logged).toEqual([{ msg: 'dashboard added a person note', fields: { personId: 2 } }]);
    expect(JSON.stringify(logged)).not.toContain('lease');
  });

  it('hides a note that a new one supersedes', async () => {
    const { dashboard } = build();
    const response = await post(dashboard, '/api/people/1/notes', { kind: 'preference', text: 'prefers calls after lunch', supersedes: 3 });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as PersonNoteView;
    const profile = await get<PersonProfile>(dashboard, '/api/people/1');
    expect(profile.preferences.map((each) => [each.id, each.text])).toEqual([[id, 'prefers calls after lunch']]);
    expect(profile.notes).toEqual(mayaProfile.notes);
  });

  it('refuses a body that is not a valid note', async () => {
    const { dashboard, store } = build();
    expect(await error(post(dashboard, '/api/people/1/notes', { kind: 'note', text: 'hi', author: 'agent' }), 400)).toBe('leave out author, because this request does not take it');
    expect(await error(post(dashboard, '/api/people/1/notes', { kind: 'note', text: '   ' }), 400)).toBe('give text as text of 1 to 2000 characters');
    expect(await error(post(dashboard, '/api/people/1/notes', { kind: 'note', text: 'a'.repeat(2001) }), 400)).toBe('give text as text of 1 to 2000 characters');
    expect(await error(post(dashboard, '/api/people/1/notes', { kind: 'reminder', text: 'hi' }), 400)).toBe('give kind as one of: note, preference');
    expect(await error(post(dashboard, '/api/people/1/notes', { kind: 'note', text: 'hi', supersedes: 0 }), 400)).toBe('give supersedes as the id of a note, a positive whole number');
    expect(await error(post(dashboard, '/api/people/1/notes', [{ kind: 'note', text: 'hi' }]), 400)).toBe('send a json object as the body');
    // note 4 belongs to tomas, so maya's note cannot supersede it.
    expect(await error(post(dashboard, '/api/people/1/notes', { kind: 'note', text: 'hi', supersedes: 4 }), 400)).toBe('supersedes names no note of this person');
    expect(store.notesAdded).toEqual([]);
    // 2000 characters is the longest note.
    expect((await post(dashboard, '/api/people/1/notes', { kind: 'note', text: 'a'.repeat(2000) })).status).toBe(201);
  });

  it('gives 404 for a note on an unknown person', async () => {
    const { dashboard } = build();
    expect(await error(post(dashboard, '/api/people/999/notes', { kind: 'note', text: 'hi' }), 404)).toBe('person not found');
    expect(await error(post(dashboard, '/api/people/abc/notes', { kind: 'note', text: 'hi' }), 404)).toBe('person not found');
  });
});

describe('the people routes in the dashboard', () => {
  it('refuses a note without a json content type', async () => {
    const { dashboard } = build({ full: true });
    const response = dashboard.request('/api/people/1/notes', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"kind":"note","text":"hi"}' });
    expect(await error(response, 415)).toBe('send a json body');
  });

  it('asks for the token when one is set', async () => {
    const { dashboard } = build({ full: true, token: 'secret-token' });
    expect(await error(dashboard.request('/api/people'), 401)).toBe('unauthorized');
    expect(await error(dashboard.request('/api/people/1'), 401)).toBe('unauthorized');
    // with the token, the request reaches the people routes. an id that is not a number never reaches the store.
    expect(await error(dashboard.request('/api/people/abc', { headers: { authorization: 'Bearer secret-token' } }), 404)).toBe('person not found');
  });
});
