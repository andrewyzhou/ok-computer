import { z } from 'zod';
import type { PersonProfile, PersonSummary } from '../dashboard/people-types.js';
import type { Db } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';
import { cleanLine } from '../signals/store.js';
import { headOf } from '../text.js';
import { localDay, localTime } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { guessedName } from './address.js';
import { NotePermission, PersonNotFound, peopleStore, type PeopleStore } from './store.js';

// the agent tools of the people memory: person_lookup, people_search (both read only) and person_note (a write).
// the names and the profiles come from other people's mail headers, so the read tools mark their output as untrusted.

export const PEOPLE_READ_TOOLS = ['person_lookup', 'people_search'] as const;
export const PEOPLE_TOOLS = [...PEOPLE_READ_TOOLS, 'person_note'] as const;

// the source name of the read outputs. the tool caller wraps the text and marks the session as tainted.
const UNTRUSTED = 'people';
// a profile stays short, so a lookup does not fill the context. the caller gives a handle for a longer text anyway.
const PROFILE_CHARS = 4000;
// a lookup by name shows at most this many people.
const NAME_HITS = 5;

export interface PeopleToolDeps {
  db: Db;
  // the default is the real store. the tests give a fake.
  store?: PeopleStore;
}

// a time of the store as the owner reads it: the local day and the time of day, for example "2026-10-17 10:00".
const whenOf = (iso: string | null, timeZone: string) => {
  if (!iso) return 'none';
  const date = new Date(iso);
  return `${localDay(date, timeZone)} ${localTime(date, timeZone)}`;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// a name, a subject or a note can hold line breaks and control characters from a header, so each one becomes one
// clean line.
const line = (text: string, limit = 200) => cleanLine(text, limit);

// the name to show: the person's name, or for a person without one a name guessed from the address and marked as a
// guess, or else the address.
function shownName(person: PersonSummary): string {
  if (person.name) return line(person.name, 120);
  const guess = guessedName(person.primaryEmail);
  return guess ? `${guess} (name guessed)` : line(person.displayName, 120);
}

// one line for a person in a list: the id, the name, the primary email, the organization, the last contact and the
// counts.
function summaryLine(person: PersonSummary, timeZone: string): string {
  const parts = [
    `id ${person.id}: ${shownName(person)} <${person.primaryEmail}>`,
    ...(person.organization ? [line(person.organization, 80)] : []),
    `last contact ${whenOf(person.lastContactAt, timeZone)}`,
    `${plural(person.mailCount, 'mail')}, ${plural(person.meetingCount, 'meeting')}`,
  ];
  return parts.join(' | ');
}

// the profile as compact lines: the head, the next meetings, the open threads, the preferences and then the notes.
function profileText(person: PersonProfile, timeZone: string): string {
  const otherNames = person.names.map((each) => each.name).filter((name) => name !== person.displayName);
  const lines = [
    `${shownName(person)} (id ${person.id})`,
    `emails: ${person.emails.map((email) => (email === person.primaryEmail ? `${email} (primary)` : email)).join(', ')}`,
    ...(otherNames.length ? [`also named: ${otherNames.map((name) => line(name, 80)).join(', ')}`] : []),
    `organization: ${person.organization ? `${line(person.organization, 80)} (${person.organizationDomain ?? 'no domain'})` : 'none'}`,
    `first contact: ${whenOf(person.firstContactAt, timeZone)}, last contact: ${whenOf(person.lastContactAt, timeZone)}`,
    `counts: ${plural(person.mailCount, 'mail')}, ${plural(person.meetingCount, 'meeting')}`,
  ];
  if (person.upcoming.length) {
    lines.push('next meetings:', ...person.upcoming.map((meeting) => `- ${whenOf(meeting.startAt, timeZone)} ${line(meeting.title)}`));
  } else {
    lines.push('next meetings: none');
  }
  if (person.openThreads.length) {
    lines.push(
      'open threads (they wrote last):',
      ...person.openThreads.map((thread) => `- ${line(thread.subject)} (last ${whenOf(thread.lastAt, timeZone)}, ${plural(thread.messages, 'message')})`),
    );
  }
  if (person.delegations.length) {
    lines.push(
      'waiting on them:',
      ...person.delegations.map((each) => `- ${line(each.title)} (${each.status}${each.dueAt ? `, due ${whenOf(each.dueAt, timeZone)}` : ''})`),
    );
  }
  const noteLine = (note: PersonProfile['notes'][number]) => `- note ${note.id} by ${note.author}, ${localDay(new Date(note.createdAt), timeZone)}: ${line(note.text, 2000)}`;
  if (person.preferences.length) lines.push('preferences:', ...person.preferences.map(noteLine));
  if (person.notes.length) lines.push('notes:', ...person.notes.map(noteLine));
  const text = lines.join('\n');
  return text.length > PROFILE_CHARS ? `${headOf(text, PROFILE_CHARS)}\n(the profile is cut here)` : text;
}

// createPeopleTools gives the three tools. the app registers them only with a google block, because the people
// memory fills from google.
export function createPeopleTools(deps: PeopleToolDeps): Tool[] {
  const { db } = deps;
  const store = deps.store ?? peopleStore;

  const personLookup = defineTool({
    name: 'person_lookup',
    description:
      'Look up one person that the owner has mail or meetings with, by email address, by id, or by name. Give exactly one of the three. The profile shows the names, the email addresses, the organization, the first and the last contact, the counts, the next meetings, the open threads, the preferences and the notes. A name that matches several people gives a short list, and then a lookup by id gives the profile.',
    input: z
      .object({
        email: z.string().trim().min(3).max(320).optional().describe('An email address of the person.'),
        id: z.number().int().positive().optional().describe('The id of the person, from people_search or an earlier lookup.'),
        name: z.string().trim().min(1).max(200).optional().describe('A name or a part of a name.'),
      })
      .refine((input) => [input.email, input.id, input.name].filter((each) => each !== undefined).length === 1, {
        message: 'give exactly one of email, id and name',
      }),
    risk: 'read',
    untrustedOutput: UNTRUSTED,
    async run(input, ctx) {
      const now = ctx.clock();
      const profileOf = (id: number) => store.getPerson(db, id, now);
      if (input.email !== undefined) {
        const found = store.findPersonByEmail(db, input.email, now);
        const profile = found && profileOf(found.id);
        if (!profile) return { content: `no person matches the email address ${line(input.email, 320)}` };
        return { content: profileText(profile, ctx.timeZone) };
      }
      if (input.id !== undefined) {
        const profile = profileOf(input.id);
        if (!profile) return { content: `no person matches the id ${input.id}` };
        return { content: profileText(profile, ctx.timeZone) };
      }
      const name = input.name!;
      const page = store.searchPeople(db, { q: name, limit: NAME_HITS }, now);
      if (!page.people.length) return { content: `no person matches the name "${line(name)}"` };
      if (page.people.length === 1) {
        const profile = profileOf(page.people[0]!.id);
        if (!profile) return { content: `no person matches the name "${line(name)}"` };
        return { content: profileText(profile, ctx.timeZone) };
      }
      const more = page.total > page.people.length ? `\n${page.total - page.people.length} more match. Give a longer name to narrow it.` : '';
      return {
        content: `${plural(page.total, 'person')} match the name "${line(name)}":\n${page.people.map((person) => `- ${summaryLine(person, ctx.timeZone)}`).join('\n')}${more}\nLook up one of them by id to see the profile.`,
      };
    },
  });

  const peopleSearch = defineTool({
    name: 'people_search',
    description:
      'Search the people that the owner has mail or meetings with. The query matches names, email addresses and organizations, and an empty query lists everyone. Sort by recent (the last contact first), frequent (the most mails and meetings first) or name. Each line gives the id, the name, the primary email, the organization, the last contact and the counts. Use person_lookup with the id for the whole profile.',
    input: z.object({
      query: z.string().trim().max(200).default(''),
      sort: z.enum(['recent', 'frequent', 'name']).default('recent'),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    risk: 'read',
    untrustedOutput: UNTRUSTED,
    async run({ query, sort, limit }, ctx) {
      const page = store.searchPeople(db, { ...(query ? { q: query } : {}), sort, limit }, ctx.clock());
      if (!page.people.length) return { content: query ? `no person matches "${line(query)}"` : 'the people memory has no person yet' };
      const lines = page.people.map((person) => summaryLine(person, ctx.timeZone));
      if (page.total > page.people.length) lines.push(`showing ${page.people.length} of ${page.total} people. Narrow the query or raise the limit to see more.`);
      return { content: lines.join('\n') };
    },
  });

  const personNote = defineTool({
    name: 'person_note',
    description:
      'Save a lasting note or preference about a person, for example "prefers morning meetings". Name the person by email address or by id; this tool never makes a new person. A note that changes an earlier one gives that note id as supersedes, and the earlier note then no longer shows. A note that the owner wrote can only be replaced by the owner. The kind preference is for how the person likes to work, and note is for the rest.',
    input: z.object({
      person: z
        .union([z.number().int().positive(), z.string().trim().min(3).max(320).regex(/@/, 'use an email address or the id of the person')])
        .describe('The email address or the id of the person.'),
      text: z.string().trim().min(1).max(2000),
      kind: z.enum(['note', 'preference']).default('note'),
      supersedes: z.number().int().positive().optional().describe('The id of an earlier note of the same person that this note replaces.'),
    }),
    risk: 'write',
    taintNote: 'Careful: the task read untrusted content. A person note lasts and later runs read it, and its text may come from outside text, so check that it says only what you want kept.',
    async run(input, ctx) {
      const now = ctx.clock();
      const person =
        typeof input.person === 'number' ? store.getPerson(db, input.person, now) : store.findPersonByEmail(db, input.person, now);
      if (!person) {
        const who = typeof input.person === 'number' ? `the id ${input.person}` : `the email address ${line(input.person, 320)}`;
        return { content: `no person matches ${who}, so no note was saved. person_note never makes a person.`, isError: true, effect: 'none' };
      }
      try {
        const note = store.addNote(
          db,
          {
            personId: person.id,
            kind: input.kind,
            text: input.text,
            author: 'agent',
            ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
            runId: ctx.runId,
            toolCallId: ctx.toolCallId ?? null,
          },
          now,
        );
        return { content: `saved note ${note.id} for ${line(person.displayName, 120)}` };
      } catch (err) {
        if (err instanceof NotePermission) {
          return {
            content: `note ${input.supersedes} was written by the owner, so only the owner can replace it, and no note was saved. Save a new note without supersedes, or ask the owner.`,
            isError: true,
            effect: 'none',
          };
        }
        if (!(err instanceof PersonNotFound)) throw err;
        const content =
          input.supersedes !== undefined
            ? `note ${input.supersedes} is not a note of ${line(person.displayName, 120)}, so no note was saved.`
            : `the person ${person.id} is gone, so no note was saved.`;
        return { content, isError: true, effect: 'none' };
      }
    },
  });

  return [personLookup, peopleSearch, personNote];
}

// the people tool names of a session profile, like googleToolsFor: main gets all three when the google sessions
// include main, an automation gets all three with auto and only the read tools with auto-read, and any other profile
// gets none.
export function peopleToolsFor(config: Pick<GoogleConfig, 'sessions'>, profile: string): string[] {
  if (profile === 'main') return config.sessions.includes('main') ? [...PEOPLE_TOOLS] : [];
  if (profile === 'auto') {
    if (config.sessions.includes('auto')) return [...PEOPLE_TOOLS];
    if (config.sessions.includes('auto-read')) return [...PEOPLE_READ_TOOLS];
  }
  return [];
}
