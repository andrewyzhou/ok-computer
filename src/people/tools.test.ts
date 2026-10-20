import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { PEOPLE_NOW } from '../../test/seed-people.js';
import type { PeoplePage, PersonNoteView, PersonProfile, PersonSummary } from '../dashboard/people-types.js';
import { openDb } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';
import { createToolRegistry, type Tool, type ToolContext } from '../tools/registry.js';
import { PersonNotFound, type NoteInput, type PeopleStore, type SearchInput } from './store.js';
import { createPeopleTools, PEOPLE_READ_TOOLS, PEOPLE_TOOLS, peopleToolsFor } from './tools.js';

// the store is a fake with the values of test/seed-people.ts at PEOPLE_NOW (the web fixtures hold the same values),
// so these tests run before the real store is built. the fake keeps the rules that the tools depend on: an address is
// found without case, a search counts its total, and a note that supersedes must belong to the same person.

const summary = (person: Partial<PersonSummary> & Pick<PersonSummary, 'id' | 'primaryEmail'>): PersonSummary => ({
  name: null,
  displayName: person.name ?? person.primaryEmail,
  emails: [person.primaryEmail],
  organization: null,
  organizationDomain: null,
  mailCount: 0,
  meetingCount: 0,
  firstContactAt: null,
  lastContactAt: null,
  nextMeetingAt: null,
  ...person,
});

const maya = summary({
  id: 1,
  name: 'Maya Lindqvist',
  primaryEmail: 'maya@northwind.example',
  emails: ['maya@northwind.example', 'maya.lindqvist@gmail.com'],
  organization: 'Northwind',
  organizationDomain: 'northwind.example',
  mailCount: 3,
  meetingCount: 1,
  firstContactAt: '2026-09-02T16:00:00.000Z',
  lastContactAt: '2026-10-17T17:00:00.000Z',
  nextMeetingAt: '2026-10-21T17:00:00.000Z',
});
const tomas = summary({
  id: 2,
  name: 'Tomas Okafor',
  primaryEmail: 'tomas.okafor@gmail.com',
  mailCount: 2,
  firstContactAt: '2026-10-10T16:00:00.000Z',
  lastContactAt: '2026-10-16T16:00:00.000Z',
});
const priya = summary({
  id: 3,
  name: 'Priya',
  primaryEmail: 'praman@berkeley.edu',
  organization: 'Berkeley',
  organizationDomain: 'berkeley.edu',
  mailCount: 1,
  meetingCount: 1,
  firstContactAt: '2026-10-01T16:00:00.000Z',
  lastContactAt: '2026-10-14T20:00:00.000Z',
  nextMeetingAt: '2026-10-22T20:00:00.000Z',
});
const noName = summary({
  id: 4,
  primaryEmail: 'k.osei@fabrikam.example',
  organization: 'Fabrikam',
  organizationDomain: 'fabrikam.example',
  mailCount: 2,
  firstContactAt: '2026-10-12T16:00:00.000Z',
  lastContactAt: '2026-10-12T18:00:00.000Z',
});
const jonas = summary({ id: 5, name: 'Jonas Weber', primaryEmail: 'jonas.weber@outlook.com', nextMeetingAt: '2026-10-25T15:00:00.000Z' });
const PEOPLE = [maya, tomas, priya, noName, jonas];
const NAMES: Record<number, string[]> = { 1: ['Maya Lindqvist', 'Maya L.'], 2: ['Tomas Okafor'], 3: ['Priya Raman'], 5: ['Jonas Weber'] };

interface StoredNote extends PersonNoteView {
  personId: number;
  supersedes: number | null;
  toolCallId: string | null;
}

function fakeStore() {
  const notes: StoredNote[] = [
    { id: 1, personId: 1, kind: 'preference', text: 'prefers morning meetings', author: 'agent', supersedes: null, runId: 'run-people-1', toolCallId: 'call-note-1', createdAt: '2026-10-01T16:00:00.000Z' },
    { id: 2, personId: 1, kind: 'note', text: 'met at the design offsite', author: 'owner', supersedes: null, runId: null, toolCallId: null, createdAt: '2026-10-05T16:00:00.000Z' },
    { id: 3, personId: 1, kind: 'preference', text: 'prefers meetings before 11:00', author: 'agent', supersedes: 1, runId: 'run-people-2', toolCallId: 'call-note-3', createdAt: '2026-10-10T16:00:00.000Z' },
    { id: 4, personId: 2, kind: 'note', text: 'waiting on the signed lease from Tomas', author: 'agent', supersedes: null, runId: 'run-people-3', toolCallId: 'call-note-4', createdAt: '2026-10-16T16:00:00.000Z' },
  ];
  const view = ({ id, kind, text, author, runId, createdAt }: StoredNote): PersonNoteView => ({ id, kind, text, author, runId, createdAt });
  const meeting = (account: string, eventId: string, title: string, startAt: string, endAt: string, role: 'organizer' | 'attendee') => ({ account, eventId, title, startAt, endAt, role });
  const upcoming: Record<number, PersonProfile['upcoming']> = {
    1: [meeting('personal', 'e-202', 'Design review', '2026-10-21T17:00:00.000Z', '2026-10-21T18:00:00.000Z', 'attendee')],
    // the cancelled meeting e-402 on 10-20 is not here, as the store leaves it out.
    3: [meeting('school', 'e-403', 'Paper draft review', '2026-10-22T20:00:00.000Z', '2026-10-22T21:00:00.000Z', 'organizer')],
    5: [meeting('personal', 'e-601', 'Intro call', '2026-10-25T15:00:00.000Z', '2026-10-25T15:30:00.000Z', 'attendee')],
  };
  const openThreads: Record<number, PersonProfile['openThreads']> = {
    2: [{ account: 'personal', threadId: 't-3', subject: 'Re: Lease for the new place', lastAt: '2026-10-16T16:00:00.000Z', messages: 2 }],
  };
  const getPerson = (_db: unknown, id: number): PersonProfile | undefined => {
    const person = PEOPLE.find((each) => each.id === id);
    if (!person) return undefined;
    const superseded = new Set(notes.map((note) => note.supersedes));
    const live = notes.filter((note) => note.personId === id && !superseded.has(note.id)).reverse();
    return {
      ...person,
      names: (NAMES[id] ?? []).map((name) => ({ name, count: 1, lastSeenAt: person.lastContactAt ?? '' })),
      emailDetails: person.emails.map((email) => ({ email, isPrimary: email === person.primaryEmail, firstSeenAt: '', lastSeenAt: '' })),
      upcoming: upcoming[id] ?? [],
      recentMeetings: [],
      openThreads: openThreads[id] ?? [],
      notes: live.filter((note) => note.kind === 'note').map(view),
      preferences: live.filter((note) => note.kind === 'preference').map(view),
      delegations: [],
    };
  };
  const searches: SearchInput[] = [];
  const store = {
    getPerson,
    findPersonByEmail: (_db: unknown, email: string) => PEOPLE.find((each) => each.emails.includes(email.trim().toLowerCase())),
    searchPeople: (_db: unknown, input: SearchInput): PeoplePage => {
      searches.push(input);
      const q = (input.q ?? '').toLowerCase();
      const matched = PEOPLE.filter((each) => !q || [...(NAMES[each.id] ?? []), each.displayName, ...each.emails, each.organization ?? ''].some((text) => text.toLowerCase().includes(q)));
      const sorted = [...matched].sort((a, b) => {
        if (input.sort === 'name') return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.id - b.id;
        if (input.sort === 'frequent') return b.mailCount + b.meetingCount - (a.mailCount + a.meetingCount) || a.id - b.id;
        return (b.lastContactAt ?? '').localeCompare(a.lastContactAt ?? '') || a.id - b.id;
      });
      return { people: sorted.slice(0, input.limit), next: null, total: sorted.length };
    },
    addNote: (_db: unknown, input: NoteInput, now: Date): PersonNoteView => {
      if (!PEOPLE.some((each) => each.id === input.personId)) throw new PersonNotFound();
      if (input.supersedes !== undefined && !notes.some((note) => note.id === input.supersedes && note.personId === input.personId)) throw new PersonNotFound('note');
      const note: StoredNote = {
        id: notes.length + 1,
        personId: input.personId,
        kind: input.kind,
        text: input.text.trim(),
        author: input.author,
        supersedes: input.supersedes ?? null,
        runId: input.runId ?? null,
        toolCallId: input.toolCallId ?? null,
        createdAt: now.toISOString(),
      };
      notes.push(note);
      return view(note);
    },
  };
  return { store: store as unknown as PeopleStore, notes, searches };
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
  const fake = fakeStore();
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
    const { run, notes } = setup();
    for (let i = 0; i < 5; i++) {
      notes.push({ id: 10 + i, personId: 2, kind: 'note', text: 'x'.repeat(1500), author: 'owner', supersedes: null, runId: null, toolCallId: null, createdAt: '2026-10-17T16:00:00.000Z' });
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
      'id 3: Priya <praman@berkeley.edu> | Berkeley | last contact 2026-10-14 13:00 | 1 mail, 1 meeting',
      'id 4: k.osei@fabrikam.example <k.osei@fabrikam.example> | Fabrikam | last contact 2026-10-12 11:00 | 2 mails, 0 meetings',
      'id 5: Jonas Weber <jonas.weber@outlook.com> | last contact none | 0 mails, 0 meetings',
    ]);
    const frequent = await run('people_search', { sort: 'frequent', limit: 2 });
    expect(frequent.content.split('\n').map((each) => each.slice(0, 5))).toEqual(['id 1:', 'id 2:', 'showi']);
    expect(frequent.content).toContain('showing 2 of 5 people.');
    const byName = await run('people_search', { sort: 'name', limit: 50 });
    expect(byName.content.split('\n').map((each) => each.slice(0, 5))).toEqual(['id 5:', 'id 4:', 'id 1:', 'id 3:', 'id 2:']);
    expect(byName.content).not.toContain('showing');
    expect((await run('people_search', { query: 'berkeley' })).content).toMatch(/^id 3: Priya/);
    expect(searches.at(-1)).toEqual({ q: 'berkeley', sort: 'recent', limit: 10 });
    expect(await run('people_search', { query: 'zelda' })).toEqual({ content: 'no person matches "zelda"' });
    const input = setup().byName('people_search').input;
    expect(input.safeParse({ limit: 51 }).success).toBe(false);
    expect(input.safeParse({ sort: 'oldest' }).success).toBe(false);
  });

  it('writes a note with the agent as author, the run and the call', async () => {
    const { run, notes } = setup();
    const saved = await run('person_note', { person: 'PRaman@Berkeley.edu', text: '  likes short agendas  ', kind: 'preference' });
    expect(saved).toEqual({ content: 'saved note 5 for Priya' });
    expect(notes.at(-1)).toMatchObject({ id: 5, personId: 3, kind: 'preference', text: 'likes short agendas', author: 'agent', runId: 'r1', toolCallId: 'c1', supersedes: null });
    const replaced = await run('person_note', { person: 1, text: 'prefers meetings before 10:00', kind: 'preference', supersedes: 3 });
    expect(replaced).toEqual({ content: 'saved note 6 for Maya Lindqvist' });
    expect(notes.at(-1)).toMatchObject({ personId: 1, supersedes: 3, kind: 'preference' });
    expect((await run('person_lookup', { id: 1 })).content).not.toContain('before 11:00');
    // the default kind is note.
    await run('person_note', { person: 2, text: 'lease signed' });
    expect(notes.at(-1)).toMatchObject({ personId: 2, kind: 'note' });
  });

  it("refuses to supersede another person's note, and an unknown person, without saving", async () => {
    const { run, notes } = setup();
    const before = notes.length;
    const other = await run('person_note', { person: 2, text: 'x', supersedes: 3 });
    expect(other).toEqual({ content: 'note 3 is not a note of Tomas Okafor, so no note was saved.', isError: true, effect: 'none' });
    const unknown = await run('person_note', { person: 'stranger@nowhere.example', text: 'x' });
    expect(unknown).toMatchObject({ isError: true, effect: 'none' });
    expect(unknown.content).toContain('no person matches the email address stranger@nowhere.example');
    const unknownId = await run('person_note', { person: 99, text: 'x' });
    expect(unknownId).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('the id 99') });
    expect(notes.length).toBe(before);
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
