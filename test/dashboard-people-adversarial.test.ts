import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeoplePage, PersonNoteView, PersonProfile } from '../src/dashboard/people-types.js';
import { mountPeople } from '../src/dashboard/people.js';
import type { DashboardDeps } from '../src/dashboard/server.js';
import { googleConfigSchema } from '../src/google/config.js';
import { createLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { PEOPLE_ACCOUNTS, PEOPLE_NOW, seedPeople } from './seed-people.js';

// adversarial requests to the people routes on the seeded database: odd ids, damaged cursors, hostile search text
// and note bodies that try to get past the checks.

let closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers) close();
  closers = [];
});

function build() {
  const t = createTestApp([], { start: PEOPLE_NOW.toISOString() });
  closers.push(() => t.db.close());
  seedPeople(t.db);
  const google = googleConfigSchema.parse({ clientId: 'seed.apps.googleusercontent.com', accounts: PEOPLE_ACCOUNTS.map((alias) => ({ alias })) });
  const deps: DashboardDeps = { db: t.db, config: { ...t.config, google }, clock: () => PEOPLE_NOW, logger: createLogger({ consoleLevel: 'off' }), app: t.app };
  const dashboard = new Hono();
  mountPeople(dashboard, deps);
  return { dashboard, db: t.db };
}

type Dashboard = ReturnType<typeof build>['dashboard'];

const post = (dashboard: Dashboard, path: string, body: string) => dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

async function status(response: Response | Promise<Response>): Promise<[number, unknown]> {
  const answer = await response;
  return [answer.status, await answer.json()];
}

const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('people routes with hostile input', () => {
  it('gives 404, never 500, for ids that are too large, signed, padded or not whole', async () => {
    const { dashboard } = build();
    for (const id of ['9999999999999999', '99999999999999999999', '0', '01', '-1', '1.5', '1e3', '%20', '1%00', 'Infinity', 'NaN']) {
      const [code, body] = await status(dashboard.request(`/api/people/${id}`));
      expect(code, id).toBe(404);
      expect(body, id).toEqual({ error: 'person not found' });
    }
  });

  it('refuses damaged and forged cursors with 400', async () => {
    const { dashboard } = build();
    for (const cursor of ['', 'x', '%%%', cursorOf({ o: -1 }), cursorOf({ o: 1.5 }), cursorOf({ o: '1' }), cursorOf([1]), cursorOf(null), cursorOf({ o: 2 ** 60 })]) {
      const [code, body] = await status(dashboard.request(`/api/people?cursor=${encodeURIComponent(cursor)}`));
      expect(code, cursor).toBe(400);
      expect(body).toEqual({ error: 'the cursor is not valid' });
    }
  });

  it('gives an empty last page for a forged cursor past the end', async () => {
    const { dashboard } = build();
    const [code, body] = await status(dashboard.request(`/api/people?cursor=${cursorOf({ o: 1000 })}`));
    expect(code).toBe(200);
    expect(body).toEqual({ people: [], next: null, total: 5 });
  });

  it('treats like wildcards and quotes in q as text', async () => {
    const { dashboard } = build();
    for (const q of ['%', '_', "'", '"', '\\', '%25', '*']) {
      const response = await dashboard.request(`/api/people?q=${encodeURIComponent(q)}`);
      expect(response.status, q).toBe(200);
      expect(((await response.json()) as PeoplePage).total, q).toBe(0);
    }
  });

  it('takes q of exactly 200 characters after trimming and refuses 201', async () => {
    const { dashboard } = build();
    expect((await dashboard.request(`/api/people?q=${encodeURIComponent(`  ${'a'.repeat(200)}  `)}`)).status).toBe(200);
    expect((await dashboard.request(`/api/people?q=${'a'.repeat(201)}`)).status).toBe(400);
  });

  it('clamps a negative, fractional or huge limit', async () => {
    const { dashboard } = build();
    for (const [limit, size] of [
      ['-5', 1],
      ['0', 1],
      ['2.9', 2],
      ['1e9', 5],
      ['abc', 5],
    ] as const) {
      const page = (await (await dashboard.request(`/api/people?limit=${limit}`)).json()) as PeoplePage;
      expect(page.people.length, limit).toBe(size);
    }
  });

  it('refuses a lookup of a list of addresses or of an empty email', async () => {
    const { dashboard } = build();
    for (const email of ['', ' ', 'a@b.com, c@d.com', 'Maya <maya@northwind.example>']) {
      expect((await dashboard.request(`/api/people/lookup?email=${encodeURIComponent(email)}`)).status, email).toBe(400);
    }
    expect((await dashboard.request('/api/people/lookup')).status).toBe(400);
  });

  it('finds a person by an address with spaces around it and angle brackets', async () => {
    const { dashboard } = build();
    const response = await dashboard.request(`/api/people/lookup?email=${encodeURIComponent(' <MAYA@Northwind.Example> ')}`);
    expect(response.status).toBe(200);
  });

  it('refuses note bodies that are not a note, and writes nothing', async () => {
    const { dashboard, db } = build();
    const before = Number((db.prepare('SELECT count(*) AS n FROM person_notes').get() as { n: number }).n);
    for (const body of [
      '',
      'not json',
      'null',
      '[]',
      '"text"',
      '{}',
      JSON.stringify({ kind: 'note', text: '   ' }),
      JSON.stringify({ kind: 'note', text: 'x'.repeat(2001) }),
      JSON.stringify({ kind: 'Note', text: 'x' }),
      JSON.stringify({ kind: 'note', text: 'x', supersedes: '1' }),
      JSON.stringify({ kind: 'note', text: 'x', supersedes: 0 }),
      JSON.stringify({ kind: 'note', text: 'x', supersedes: 1.5 }),
      JSON.stringify({ kind: 'note', text: 'x', author: 'agent' }),
      JSON.stringify({ kind: 'note', text: 'x', personId: 2 }),
      JSON.stringify({ kind: 'note', text: 42 }),
    ]) {
      const response = await post(dashboard, '/api/people/1/notes', body);
      expect(response.status, body).toBe(400);
      expect(Object.keys((await response.json()) as object), body).toEqual(['error']);
    }
    expect(Number((db.prepare('SELECT count(*) AS n FROM person_notes').get() as { n: number }).n)).toBe(before);
  });

  it('refuses a supersedes of a note of another person with 400 and a supersedes of an unknown note too', async () => {
    const { dashboard } = build();
    // note 4 belongs to person 2.
    expect((await post(dashboard, '/api/people/1/notes', JSON.stringify({ kind: 'note', text: 'x', supersedes: 4 }))).status).toBe(400);
    expect((await post(dashboard, '/api/people/1/notes', JSON.stringify({ kind: 'note', text: 'x', supersedes: 999 }))).status).toBe(400);
  });

  it('keeps hostile note text as it is, trimmed, and gives it back as data', async () => {
    const { dashboard } = build();
    const text = '<script>alert(1)</script>\n"; DROP TABLE people; --‮';
    const response = await post(dashboard, '/api/people/2/notes', JSON.stringify({ kind: 'note', text: `  ${text}  ` }));
    expect(response.status).toBe(201);
    const note = (await response.json()) as PersonNoteView;
    expect(note.text).toBe(text);
    expect(note.author).toBe('owner');
    const profile = (await (await dashboard.request('/api/people/2')).json()) as PersonProfile;
    expect(profile.notes[0]!.text).toBe(text);
  });

  it('takes a note of 2000 characters after trimming', async () => {
    const { dashboard } = build();
    expect((await post(dashboard, '/api/people/2/notes', JSON.stringify({ kind: 'preference', text: ` ${'y'.repeat(2000)} ` }))).status).toBe(201);
  });

  it('writes two notes posted at once, both kept', async () => {
    const { dashboard, db } = build();
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => post(dashboard, '/api/people/2/notes', JSON.stringify({ kind: 'note', text: `n${i}` }))));
    expect(answers.map((each) => each.status)).toEqual(Array(10).fill(201));
    const ids = new Set(await Promise.all(answers.map(async (each) => ((await each.json()) as PersonNoteView).id)));
    expect(ids.size).toBe(10);
    expect(Number((db.prepare('SELECT count(*) AS n FROM person_notes WHERE personId = 2').get() as { n: number }).n)).toBe(11);
  });
});
