import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { PEOPLE_NOW, seedPeople } from '../../test/seed-people.js';
import type { PeoplePage, PersonNoteView } from '../dashboard/people-types.js';
import { openDb, type Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { GoogleConfig } from '../google/config.js';
import { createToolRegistry, type Tool, type ToolContext } from '../tools/registry.js';
import { peopleStore, type PeopleStore, type SearchInput } from './store.js';
import { createPeopleTools, PEOPLE_READ_TOOLS, PEOPLE_TOOLS, peopleToolsFor } from './tools.js';

// the tools run on the real store over the seeded database of test/seed-people.ts, with the clock at PEOPLE_NOW (the
// web fixtures hold the same values). the store is wrapped so a test can see each search that a tool sends.

interface StoredNote extends Omit<PersonNoteView, 'tainted'> {
  personId: number;
  supersedes: number | null;
  toolCallId: string | null;
}

function recordingStore(db: Db) {
  const searches: SearchInput[] = [];
  const store: PeopleStore = {
    ...peopleStore,
    searchPeople: (db: Db, input: SearchInput, now: Date): PeoplePage => {
      searches.push(input);
      return peopleStore.searchPeople(db, input, now);
    },
  };
  const notes = () => db.prepare('SELECT id, personId, kind, text, author, supersedes, runId, toolCallId, createdAt FROM person_notes ORDER BY id').all() as unknown as StoredNote[];
  const addNote = (note: StoredNote) =>
    db
      .prepare('INSERT INTO person_notes (id, personId, kind, text, author, supersedes, runId, toolCallId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(note.id, note.personId, note.kind, note.text, note.author, note.supersedes, note.runId, note.toolCallId, note.createdAt);
  return { store, searches, notes, addNote };
}

const ctx = (): ToolContext => ({
  runId: 'r1',
  sessionKey: 'main',
  timeZone: 'America/Los_Angeles',
  clock: () => PEOPLE_NOW,
  signal: new AbortController().signal,
  toolCallId: 'c1',
});

function setup() {
  const db = openDb(':memory:');
  seedPeople(db);
  const fake = recordingStore(db);
  const tools = createPeopleTools({ db, store: fake.store });
  const byName = (name: string) => tools.find((tool) => tool.name === name)!;
  // the input goes through the schema first, as in the registry, so the defaults apply.
  const run = async (name: string, input: unknown) => {
    const tool = byName(name);
    return tool.run(tool.input.parse(input), ctx());
  };
  return { db, tools, byName, run, ...fake };
}

describe('the people tools', () => {
  it('gives the three tools in order, with their risks and the untrusted source on the reads', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual([...PEOPLE_TOOLS]);
    expect(tools.map((tool) => tool.risk)).toEqual(['read', 'read', 'write']);
    expect(tools.map((tool) => tool.untrustedOutput)).toEqual(['people', 'people', undefined]);
    expect(tools[2]!.taintNote).toMatch(/lasts/);
  });

  it('looks a person up by email without case, and by id', async () => {
    const { run } = setup();
    const byEmail = await run('person_lookup', { email: 'Maya@Northwind.EXAMPLE' });
    expect(byEmail.isError).toBeUndefined();
    expect(byEmail.content).toMatch(/^Maya Lindqvist \(id 1\)\n/);
    expect(byEmail.content).toContain('emails: maya@northwind.example (primary), maya.lindqvist@gmail.com');
    expect(byEmail.content).toContain('also named: Maya L.');
    expect(byEmail.content).toContain('organization: Northwind (northwind.example)');
    // 09-02 16:00 utc is 09:00 in los angeles, and 10-17 17:00 utc is 10:00.
    expect(byEmail.content).toContain('first contact: 2026-09-02 09:00, last contact: 2026-10-17 10:00');
    expect(byEmail.content).toContain('counts: 3 mails, 1 meeting');
    expect(byEmail.content).toContain('- 2026-10-21 10:00 Design review');
    const byId = await run('person_lookup', { id: 1 });
    expect(byId.content).toBe(byEmail.content);
    // the alternative address finds the same person.
    expect((await run('person_lookup', { email: 'maya.lindqvist@gmail.com' })).content).toBe(byEmail.content);
  });

  it('shows the live preference and not the one it superseded, then the notes with ids and authors', async () => {
    const { run } = setup();
    const { content } = await run('person_lookup', { id: 1 });
    expect(content).toContain('preferences:\n- note 3 by agent, 2026-10-10: prefers meetings before 11:00');
    expect(content).not.toContain('prefers morning meetings');
    expect(content).toContain('notes:\n- note 2 by owner, 2026-10-05: met at the design offsite');
    expect(content.indexOf('preferences:')).toBeLessThan(content.indexOf('notes:'));
  });

  it("shows Tomas's open thread and Priya's upcoming meeting but not the cancelled one", async () => {
    const { run } = setup();
    const tomas = await run('person_lookup', { email: 'tomas.okafor@gmail.com' });
    expect(tomas.content).toContain('open threads (they wrote last):\n- Re: Lease for the new place (last 2026-10-16 09:00, 2 messages)');
    expect(tomas.content).toContain('organization: none');
    expect(tomas.content).toContain('next meetings: none');
    const priya = await run('person_lookup', { id: 3 });
    expect(priya.content).toContain('- 2026-10-22 13:00 Paper draft review');
    expect(priya.content).not.toContain('2026-10-20');
    expect(priya.content).not.toContain('open threads');
  });

  it('looks up by name with one, many and no hits', async () => {
    const { run, searches } = setup();
    const one = await run('person_lookup', { name: 'tomas' });
    expect(one.content).toMatch(/^Tomas Okafor \(id 2\)/);
    expect(searches.at(-1)).toEqual({ q: 'tomas', limit: 5 });
    // "ma" is in Maya, in Tomas and in the address of Priya.
    const many = await run('person_lookup', { name: 'ma' });
    expect(many.isError).toBeUndefined();
    expect(many.content).toMatch(/^3 persons match the name "ma":/);
    expect(many.content).toContain('- id 1: Maya Lindqvist <maya@northwind.example>');
    expect(many.content).toContain('- id 2: Tomas Okafor');
    expect(many.content).toContain('Look up one of them by id');
    const none = await run('person_lookup', { name: 'Zelda' });
    expect(none).toEqual({ content: 'no person matches the name "Zelda"' });
    expect(await run('person_lookup', { email: 'nobody@nowhere.example' })).toEqual({ content: 'no person matches the email address nobody@nowhere.example' });
    expect(await run('person_lookup', { id: 99 })).toEqual({ content: 'no person matches the id 99' });
  });

  it('asks for exactly one of email, id and name', () => {
    const { byName } = setup();
    const input = byName('person_lookup').input;
    for (const bad of [{}, { email: 'maya@northwind.example', id: 1 }, { id: 1, name: 'Maya' }]) {
      const parsed = input.safeParse(bad);
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues[0]!.message).toBe('give exactly one of email, id and name');
    }
    expect(input.safeParse({ id: 0 }).success).toBe(false);
    expect(input.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
  });

  it('cuts a long profile to about 4000 characters', async () => {
    const { run, addNote } = setup();
    for (let i = 0; i < 5; i++) {
      addNote({ id: 10 + i, personId: 2, kind: 'note', text: 'x'.repeat(1500), author: 'owner', supersedes: null, runId: null, toolCallId: null, createdAt: '2026-10-17T16:00:00.000Z' });
    }
    const { content } = await run('person_lookup', { id: 2 });
    expect(content.length).toBeLessThan(4100);
    expect(content).toMatch(/\(the profile is cut here\)$/);
  });

  it('searches with the default sort recent, the other sorts and the limit, with a total line', async () => {
    const { run, searches } = setup();
    const all = await run('people_search', {});
    expect(searches.at(-1)).toEqual({ sort: 'recent', limit: 10 });
    expect(all.content.split('\n')).toEqual([
      'id 1: Maya Lindqvist <maya@northwind.example> | Northwind | last contact 2026-10-17 10:00 | 3 mails, 1 meeting',
      'id 2: Tomas Okafor <tomas.okafor@gmail.com> | last contact 2026-10-16 09:00 | 2 mails, 0 meetings',
      'id 3: Priya <praman@northgate.edu> | Northgate | last contact 2026-10-14 13:00 | 1 mail, 1 meeting',
      'id 4: K Osei (name guessed) <k.osei@fabrikam.example> | Fabrikam | last contact 2026-10-12 11:00 | 2 mails, 0 meetings',
      'id 5: Jonas Weber <jonas.weber@outlook.com> | last contact none | 0 mails, 0 meetings',
    ]);
    const frequent = await run('people_search', { sort: 'frequent', limit: 2 });
    expect(frequent.content.split('\n').map((each) => each.slice(0, 5))).toEqual(['id 1:', 'id 2:', 'showi']);
    expect(frequent.content).toContain('showing 2 of 5 people.');
    const byName = await run('people_search', { sort: 'name', limit: 50 });
    expect(byName.content.split('\n').map((each) => each.slice(0, 5))).toEqual(['id 5:', 'id 4:', 'id 1:', 'id 3:', 'id 2:']);
    expect(byName.content).not.toContain('showing');
    expect((await run('people_search', { query: 'northgate' })).content).toMatch(/^id 3: Priya/);
    expect(searches.at(-1)).toEqual({ q: 'northgate', sort: 'recent', limit: 10 });
    expect(await run('people_search', { query: 'zelda' })).toEqual({ content: 'no person matches "zelda"' });
    const input = setup().byName('people_search').input;
    expect(input.safeParse({ limit: 51 }).success).toBe(false);
    expect(input.safeParse({ sort: 'oldest' }).success).toBe(false);
  });

  it('writes a note with the agent as author, the run and the call', async () => {
    const { run, notes } = setup();
    const saved = await run('person_note', { person: 'PRaman@Northgate.edu', text: '  likes short agendas  ', kind: 'preference' });
    expect(saved).toEqual({ content: 'saved note 5 for Priya' });
    expect(notes().at(-1)).toMatchObject({ id: 5, personId: 3, kind: 'preference', text: 'likes short agendas', author: 'agent', runId: 'r1', toolCallId: 'c1', supersedes: null });
    const replaced = await run('person_note', { person: 1, text: 'prefers meetings before 10:00', kind: 'preference', supersedes: 3 });
    expect(replaced).toEqual({ content: 'saved note 6 for Maya Lindqvist' });
    expect(notes().at(-1)).toMatchObject({ personId: 1, supersedes: 3, kind: 'preference' });
    expect((await run('person_lookup', { id: 1 })).content).not.toContain('before 11:00');
    // the default kind is note.
    await run('person_note', { person: 2, text: 'lease signed' });
    expect(notes().at(-1)).toMatchObject({ personId: 2, kind: 'note' });
  });

  it("refuses to supersede another person's note, and an unknown person, without saving", async () => {
    const { run, notes } = setup();
    const before = notes().length;
    const other = await run('person_note', { person: 2, text: 'x', supersedes: 3 });
    expect(other).toEqual({ content: 'note 3 is not a note of Tomas Okafor, so no note was saved.', isError: true, effect: 'none' });
    const unknown = await run('person_note', { person: 'stranger@nowhere.example', text: 'x' });
    expect(unknown).toMatchObject({ isError: true, effect: 'none' });
    expect(unknown.content).toContain('no person matches the email address stranger@nowhere.example');
    const unknownId = await run('person_note', { person: 99, text: 'x' });
    expect(unknownId).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('the id 99') });
    expect(notes().length).toBe(before);
  });

  it('checks the note input', () => {
    const input = setup().byName('person_note').input;
    expect(input.safeParse({ person: 'Maya', text: 'x' }).success).toBe(false);
    expect(input.safeParse({ person: 1, text: '   ' }).success).toBe(false);
    expect(input.safeParse({ person: 1, text: 'x'.repeat(2001) }).success).toBe(false);
    expect(input.safeParse({ person: 1, text: 'x', kind: 'secret' }).success).toBe(false);
    expect(input.safeParse({ person: 1, text: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('allows a lookup through the registry and the policy by the rule risk:read, and marks its output', async () => {
    const { db, tools } = setup();
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
    const { caller } = createTestCaller(db, createToolRegistry(tools as Tool[]), () => PEOPLE_NOW);
    const output = await caller.call(
      { id: 'lookup-call', name: 'person_lookup', input: { email: 'maya@northwind.example' } },
      { runId: 'r1', sessionKey: 'main', allowed: [...PEOPLE_TOOLS], signal: new AbortController().signal },
    );
    expect(output.untrustedSource).toBe('people');
    expect(output.content).toContain('Maya Lindqvist');
    const decision = db.prepare("SELECT decision, rule FROM policy_decisions WHERE toolCallId = 'lookup-call'").get();
    expect(decision).toEqual({ decision: 'allow', rule: 'risk:read' });
  });

  it('allows a note through the policy by its builtin rule, because it changes only the local database', async () => {
    const { db, tools, notes } = setup();
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
    const { caller } = createTestCaller(db, createToolRegistry(tools as Tool[]), () => PEOPLE_NOW);
    const output = await caller.call(
      { id: 'note-call', name: 'person_note', input: { person: 2, text: 'lease signed' } },
      { runId: 'r1', sessionKey: 'main', allowed: [...PEOPLE_TOOLS], signal: new AbortController().signal },
    );
    expect(output.content).toBe('saved note 5 for Tomas Okafor');
    expect(notes().at(-1)).toMatchObject({ personId: 2, runId: 'r1', toolCallId: 'note-call' });
    const decision = db.prepare("SELECT decision, rule FROM policy_decisions WHERE toolCallId = 'note-call'").get();
    expect(decision).toEqual({ decision: 'allow', rule: 'builtin:person_note' });
  });

  it('keeps the taint of the session with an agent note, and the lookup marks the note', async () => {
    const { db, run } = setup();
    // a gmail_read result of the session, as the tool caller writes it.
    appendEvent(
      db,
      { sessionKey: 'main', runId: 'r1', type: 'tool_result', payload: { toolCallId: 'read-1', name: 'gmail_read', content: 'x', isError: false, untrustedSource: 'gmail' } },
      PEOPLE_NOW,
    );
    expect(await run('person_note', { person: 2, text: 'lease signed' })).toEqual({ content: 'saved note 5 for Tomas Okafor' });
    const taint = JSON.parse(String(db.prepare('SELECT taint FROM person_notes WHERE id = 5').get()!.taint)) as Array<{ source: string }>;
    expect(taint.map((each) => each.source)).toEqual(['gmail']);
    const profile = peopleStore.getPerson(db, 2, PEOPLE_NOW)!;
    expect(profile.notes.find((note) => note.id === 5)).toMatchObject({ author: 'agent', tainted: true });
    // the seeded note 4 was written by a run that had read a mail, and the owner's note 2 has no taint.
    expect(profile.notes.find((note) => note.id === 4)).toMatchObject({ tainted: true });
    expect(peopleStore.getPerson(db, 1, PEOPLE_NOW)!.notes.find((note) => note.id === 2)).toMatchObject({ author: 'owner', tainted: false });
    const lookup = await run('person_lookup', { id: 2 });
    expect(lookup.content).toMatch(/- note 5 by agent after reading outside text, \S+: lease signed/);
    expect((await run('person_lookup', { id: 1 })).content).toMatch(/- note 2 by owner, \S+: met at the design offsite/);
  });
});

describe('peopleToolsFor', () => {
  const config = (sessions: GoogleConfig['sessions']) => ({ sessions });
  it.each<[GoogleConfig['sessions'], string, string[]]>([
    [['main'], 'main', [...PEOPLE_TOOLS]],
    [['auto'], 'main', []],
    [['main', 'auto'], 'auto', [...PEOPLE_TOOLS]],
    [['main', 'auto-read'], 'auto', [...PEOPLE_READ_TOOLS]],
    [['main'], 'auto', []],
    [['main', 'auto'], 'heartbeat', []],
    [['main', 'auto'], 'sub:research', []],
  ])('gives the sessions %j and the profile %s the tools %j', (sessions, profile, tools) => {
    expect(peopleToolsFor(config(sessions), profile)).toEqual(tools);
  });
});
