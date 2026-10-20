import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { createLogger } from '../observability/logger.js';
import { cleanName, isPersonalDomain, normalizeEmail, organizationOf, parseAddressList } from './address.js';
import { createPeopleBuilder, eventObservations, mailObservations } from './builder.js';
import { addressNoise, mailNoise } from './noise.js';
import {
  addNote,
  cancelMeetings,
  findPersonByEmail,
  getPerson,
  InvalidMerge,
  mergePeople,
  PersonNotFound,
  recordObservation,
  recordObservations,
  searchPeople,
} from './store.js';
import type { Contact, Observation } from './types.js';

// adversarial cases for the people memory: hostile headers, odd addresses, time zones and day boundaries, and the
// store under repeated and out-of-order reads.

const OWNER = new Set(['owner@example.com']);
const TZ = 'America/Los_Angeles';
const silent = createLogger({ consoleLevel: 'off' });

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});
const fresh = (): Db => {
  db = openDb(':memory:');
  return db;
};

function message(headers: Record<string, string | string[]>, extra: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message {
  const list = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((each) => ({ name, value: each })));
  return { id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-10-10T16:00:00Z')), labelIds: ['INBOX'], payload: { headers: list }, ...extra };
}

function observation(email: string, name: string | null, contact: Partial<Contact> = {}, organization: Observation['organization'] = null): Observation {
  return {
    address: { email, name },
    organization,
    contact: {
      kind: 'mail',
      account: 'personal',
      externalId: 'm-1',
      threadId: 't-1',
      direction: 'in',
      role: 'from',
      subject: 'Hello',
      at: '2026-10-10T16:00:00.000Z',
      endAt: null,
      cancelled: false,
      ...contact,
    },
  };
}

const emails = (list: Array<{ email: string }>) => list.map((each) => each.email);

describe('address parsing of hostile headers', () => {
  it('keeps a comma inside a quoted name and a comment as part of the name', () => {
    expect(parseAddressList('"Doe, Jane (CEO)" <jane@acme.com>, bob@acme.com (Bob, the builder)')).toEqual([
      { email: 'jane@acme.com', name: 'Doe, Jane (CEO)' },
      { email: 'bob@acme.com', name: 'Bob, the builder' },
    ]);
  });

  it('takes the address in angle brackets, not an address written in the name', () => {
    const [first] = parseAddressList('"ceo@bank.com" <attacker@evil.example>');
    expect(first!.email).toBe('attacker@evil.example');
  });

  it('does not let an escaped quote end a quoted name early', () => {
    expect(parseAddressList('"Jane \\"JJ\\", Doe" <jane@acme.com>')).toEqual([{ email: 'jane@acme.com', name: 'Jane "JJ", Doe' }]);
  });

  it('drops a group name and keeps its members, also with an empty group', () => {
    expect(emails(parseAddressList('undisclosed-recipients:;'))).toEqual([]);
    expect(emails(parseAddressList('Team: a@acme.com, b@acme.com;, c@acme.com'))).toEqual(['a@acme.com', 'b@acme.com', 'c@acme.com']);
  });

  it('survives an unclosed quote, an unclosed angle bracket and an unclosed comment without throwing', () => {
    expect(() => parseAddressList('"Jane <jane@acme.com>, bob@acme.com')).not.toThrow();
    expect(() => parseAddressList('Jane <jane@acme.com, bob@acme.com')).not.toThrow();
    expect(() => parseAddressList('jane@acme.com (Jane, bob@acme.com')).not.toThrow();
    expect(() => parseAddressList('\\')).not.toThrow();
    expect(() => parseAddressList('"\\')).not.toThrow();
  });

  it('reads a very long header in linear time', () => {
    const header = Array.from({ length: 5000 }, (_, i) => `"Person, ${i}" <p${i}@acme.com>`).join(', ');
    const started = performance.now();
    const list = parseAddressList(header);
    expect(list).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('does not hang on deeply nested comments', () => {
    const header = `${'('.repeat(10000)}x${')'.repeat(10000)} jane@acme.com`;
    expect(emails(parseAddressList(header))).toEqual(['jane@acme.com']);
  });

  it('folds line breaks and tabs of a folded header out of the name', () => {
    expect(parseAddressList('"Jane\r\n\tDoe" <jane@acme.com>,\r\n bob@acme.com')).toEqual([
      { email: 'jane@acme.com', name: 'Jane Doe' },
      { email: 'bob@acme.com', name: null },
    ]);
  });

  it('keeps an address that comes twice once, with the first name, and merges case', () => {
    expect(parseAddressList('Jane <JANE@acme.com>, J. <jane@ACME.com>')).toEqual([{ email: 'jane@acme.com', name: 'Jane' }]);
  });

  it('gives null for a name that is only quotes or only the address in another case', () => {
    expect(parseAddressList('"" <jane@acme.com>')[0]!.name).toBeNull();
    expect(parseAddressList("'JANE@ACME.COM' <jane@acme.com>")[0]!.name).toBeNull();
    expect(cleanName('  ""  ', 'x@y.com')).toBeNull();
    expect(cleanName(undefined, 'x@y.com')).toBeNull();
  });

  it('rejects addresses with spaces, brackets or no domain dot, and never throws on odd text', () => {
    for (const bad of ['', ' ', '@', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a@b..com', 'a@-', 'a@b.com.', 'a@[1.2.3.4]', '"a"@b.com', 'a@b_c.com']) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    expect(normalizeEmail(' <Jane.Doe+tag@Acme.COM> ')).toBe('jane.doe+tag@acme.com');
    expect(normalizeEmail(`${'a'.repeat(250)}@b.com`)).toBeNull();
  });

  it('keeps the plus tag and the dots of an address', () => {
    expect(normalizeEmail('jane.doe+x@gmail.com')).toBe('jane.doe+x@gmail.com');
  });
});

describe('organizations and personal domains', () => {
  it('gives no organization for personal domains in any case and their country families', () => {
    for (const domain of ['GMAIL.COM', 'googlemail.com', 'yahoo.co.uk', 'outlook.de', 'hotmail.co.jp', 'live.com', 'icloud.com', ' proton.me ']) {
      expect(isPersonalDomain(domain), domain).toBe(true);
      expect(organizationOf(domain), domain).toBeNull();
    }
  });

  it('reads the registrable domain under a two-part suffix and a deep subdomain', () => {
    expect(organizationOf('mail.eu.acme.com')).toEqual({ name: 'Acme', domain: 'acme.com' });
    expect(organizationOf('cs.ox.ac.uk')).toEqual({ name: 'Ox', domain: 'ox.ac.uk' });
    expect(organizationOf('acme.co.uk')).toEqual({ name: 'Acme', domain: 'acme.co.uk' });
  });

  it('gives no organization for a bare two-part suffix or a bad domain', () => {
    expect(organizationOf('co.uk')).toBeNull();
    expect(organizationOf('')).toBeNull();
    expect(organizationOf('not a domain')).toBeNull();
    expect(organizationOf('acme')).toBeNull();
  });

  it('gives no organization for a subdomain of a personal domain', () => {
    expect(organizationOf('mail.gmail.com')).toBeNull();
  });
});

describe('noise rules', () => {
  it('treats no-reply in any case and with a plus tag as no-reply', () => {
    for (const email of ['NoReply@acme.com', 'no-reply+abc@acme.com', 'do_not_reply@acme.com', 'MAILER-DAEMON@acme.com', 'bounces@lists.acme.com', 'reply.noreply@acme.com']) {
      expect(addressNoise({ email, name: null }), email).toBe('no_reply');
    }
  });

  it('does not treat real names that contain the words as noise', () => {
    for (const email of ['newsom@acme.com', 'olivia@acme.com', 'teamwork.lead@acme.com', 'helen@acme.com', 'infante@acme.com', 'adminah@acme.com', 'jane.doe+work@acme.com']) {
      expect(addressNoise({ email, name: null }), email).toBeNull();
    }
    expect(addressNoise({ email: 'olivia@acme.com', name: 'Olivia Viana' })).toBeNull();
  });

  it('treats a via name as a notification, in either form', () => {
    expect(addressNoise({ email: 'drive@acme.com', name: 'Jane Doe (via Google Docs)' })).toBe('notification');
    expect(addressNoise({ email: 'x@acme.com', name: 'Jane Doe via Slack' })).toBe('notification');
  });

  it('treats a calendar resource domain in any case as a resource', () => {
    expect(addressNoise({ email: 'C_ABC@resource.calendar.google.com', name: null })).toBe('calendar_resource');
    expect(addressNoise({ email: 'x@group.v.calendar.google.com', name: null })).toBe('calendar_resource');
  });

  it('gives invalid for an address that does not parse', () => {
    expect(addressNoise({ email: 'not an address', name: null })).toBe('invalid');
  });

  it('reads the mail headers with odd spaces and case', () => {
    const base = { listId: '', listUnsubscribe: '', precedence: '', autoSubmitted: '', labels: [] as string[] };
    expect(mailNoise({ ...base, precedence: '  BULK ' })).toBe('bulk');
    expect(mailNoise({ ...base, autoSubmitted: ' No ' })).toBeNull();
    expect(mailNoise({ ...base, autoSubmitted: 'auto-replied' })).toBe('auto_submitted');
    expect(mailNoise({ ...base, listId: '   ' })).toBeNull();
    expect(mailNoise(base)).toBeNull();
  });
});

describe('mailObservations on hostile mail', () => {
  it('reads header names without case and joins a To header that came twice', () => {
    const result = mailObservations(
      'personal',
      message({ FROM: 'Jane <jane@acme.com>', to: ['owner@example.com', 'bob@acme.com'], cC: 'carol@acme.com' }),
      OWNER,
    );
    expect(result.observations.map((each) => [each.address.email, each.contact.role])).toEqual([
      ['jane@acme.com', 'from'],
      ['bob@acme.com', 'to'],
      ['carol@acme.com', 'cc'],
    ]);
  });

  it('treats the owner in another case as the owner', () => {
    const result = mailObservations('personal', message({ From: 'Me <OWNER@Example.COM>', To: 'jane@acme.com' }), OWNER);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.contact).toMatchObject({ direction: 'out', role: 'to' });
  });

  it('makes nothing from a mail of the owner to the owner', () => {
    const result = mailObservations('personal', message({ From: 'owner@example.com', To: 'owner@example.com' }), OWNER);
    expect(result.observations).toEqual([]);
  });

  it('keeps one role for an address that is in to and cc', () => {
    const result = mailObservations('personal', message({ From: 'jane@acme.com', To: 'bob@acme.com', Cc: 'BOB@acme.com, jane@acme.com' }), OWNER);
    expect(result.observations.map((each) => [each.address.email, each.contact.role])).toEqual([
      ['jane@acme.com', 'from'],
      ['bob@acme.com', 'to'],
    ]);
  });

  it('leaves out spam, trash and drafts, and a mailing list even with a real sender', () => {
    for (const label of ['SPAM', 'TRASH', 'DRAFT']) {
      expect(mailObservations('personal', message({ From: 'jane@acme.com' }, { labelIds: [label] }), OWNER).observations).toEqual([]);
    }
    expect(mailObservations('personal', message({ From: 'jane@acme.com', 'List-Id': '<team.acme.com>' }), OWNER).skipped).toEqual({ mailing_list: 1 });
  });

  it('keeps only the sender of a mail with too many recipients', () => {
    const to = Array.from({ length: 21 }, (_, i) => `p${i}@acme.com`).join(', ');
    const result = mailObservations('personal', message({ From: 'jane@acme.com', To: to }), OWNER);
    expect(emails(result.observations.map((each) => each.address))).toEqual(['jane@acme.com']);
    expect(result.skipped.too_many_recipients).toBe(1);
  });

  it('cuts a long subject with control characters to one clean line', () => {
    const subject = `Hello\r\nBcc: victim@acme.com\u0000‮${'x'.repeat(500)}`;
    const result = mailObservations('personal', message({ From: 'jane@acme.com', Subject: subject }), OWNER);
    const kept = result.observations[0]!.contact.subject!;
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(kept).not.toMatch(/[\r\n\u0000]/);
  });

  it('gives a mail with no subject a null subject', () => {
    expect(mailObservations('personal', message({ From: 'jane@acme.com', Subject: '   ' }), OWNER).observations[0]!.contact.subject).toBeNull();
  });

  it('reads the date header when the internal date is missing, and leaves the mail out when neither is a time', () => {
    const withDate = mailObservations('personal', message({ From: 'jane@acme.com', Date: 'Sat, 10 Oct 2026 09:00:00 -0700' }, { internalDate: null }), OWNER);
    expect(withDate.observations[0]!.contact.at).toBe('2026-10-10T16:00:00.000Z');
    const none = mailObservations('personal', message({ From: 'jane@acme.com', Date: 'yesterday-ish' }, { internalDate: 'abc' }), OWNER);
    expect(none.observations).toEqual([]);
    expect(none.skipped).toEqual({ invalid: 1 });
  });

  it('leaves out a mail without an id', () => {
    expect(mailObservations('personal', message({ From: 'jane@acme.com' }, { id: null }), OWNER).observations).toEqual([]);
  });

  it('survives a message with no payload or no headers', () => {
    expect(mailObservations('personal', { id: 'x', internalDate: '1' }, OWNER).observations).toEqual([]);
    expect(mailObservations('personal', { id: 'x', internalDate: '1', payload: { headers: [{ name: null, value: null }] } }, OWNER).observations).toEqual([]);
  });

});

function event(extra: Partial<calendar_v3.Schema$Event>): calendar_v3.Schema$Event {
  return {
    id: 'e1',
    status: 'confirmed',
    summary: 'Sync',
    start: { dateTime: '2026-10-21T10:00:00-07:00' },
    end: { dateTime: '2026-10-21T10:30:00-07:00' },
    organizer: { email: 'owner@example.com', self: true },
    attendees: [
      { email: 'owner@example.com', self: true, responseStatus: 'accepted' },
      { email: 'jane@acme.com', displayName: 'Jane', responseStatus: 'accepted' },
    ],
    ...extra,
  };
}

describe('eventObservations at day boundaries and time zones', () => {
  it('turns an offset time into utc', () => {
    expect(eventObservations('personal', [event({})], OWNER, TZ).observations[0]!.contact).toMatchObject({
      at: '2026-10-21T17:00:00.000Z',
      endAt: '2026-10-21T17:30:00.000Z',
    });
  });

  it('starts an all-day event at midnight in the owner zone, on both sides of a daylight change', () => {
    const before = eventObservations('personal', [event({ start: { date: '2026-10-31' }, end: { date: '2026-11-01' } })], OWNER, TZ).observations[0]!.contact;
    expect(before.at).toBe('2026-10-31T07:00:00.000Z');
    expect(before.endAt).toBe('2026-11-01T07:00:00.000Z');
    const after = eventObservations('personal', [event({ start: { date: '2026-11-02' }, end: { date: '2026-11-03' } })], OWNER, TZ).observations[0]!.contact;
    expect(after.at).toBe('2026-11-02T08:00:00.000Z');
  });

  it('starts an all-day event in a zone east of utc on the day before in utc', () => {
    const contact = eventObservations('personal', [event({ start: { date: '2026-10-21' }, end: { date: '2026-10-22' } })], OWNER, 'Asia/Tokyo').observations[0]!.contact;
    expect(contact.at).toBe('2026-10-20T15:00:00.000Z');
  });

  it('leaves out an event with a bad start', () => {
    const result = eventObservations('personal', [event({ start: { dateTime: 'soon' } }), event({ id: 'e2', start: { date: '2026-13-45x' } })], OWNER, TZ);
    expect(result.observations).toEqual([]);
    expect(result.skipped.invalid).toBe(2);
  });

  it('marks a declined attendee as cancelled, and keeps the others', () => {
    const result = eventObservations(
      'personal',
      [event({ attendees: [{ email: 'owner@example.com', self: true }, { email: 'jane@acme.com', responseStatus: 'declined' }, { email: 'bob@acme.com' }] })],
      OWNER,
      TZ,
    );
    expect(result.observations.map((each) => [each.address.email, each.contact.cancelled])).toEqual([
      ['jane@acme.com', true],
      ['bob@acme.com', false],
    ]);
  });

  it('keeps a meeting of 25 attendees and leaves out one of 26', () => {
    const attendees = (n: number) => [{ email: 'owner@example.com', self: true }, ...Array.from({ length: n - 1 }, (_, i) => ({ email: `p${i}@acme.com` }))];
    expect(eventObservations('personal', [event({ attendees: attendees(25) })], OWNER, TZ).observations).toHaveLength(24);
    const large = eventObservations('personal', [event({ attendees: attendees(26) })], OWNER, TZ);
    expect(large.observations).toEqual([]);
    expect(large.skipped).toEqual({ large_meeting: 1 });
  });

  it('makes an organizer that is not an attendee a person, and a group organizer none', () => {
    const external = eventObservations('personal', [event({ organizer: { email: 'Boss@Acme.com', displayName: 'Boss' }, attendees: [{ email: 'owner@example.com', self: true }] })], OWNER, TZ);
    expect(external.observations.map((each) => [each.address.email, each.contact.role])).toEqual([['boss@acme.com', 'organizer']]);
    const group = eventObservations('personal', [event({ organizer: { email: 'team@group.calendar.google.com' }, attendees: [{ email: 'owner@example.com', self: true }] })], OWNER, TZ);
    expect(group.observations).toEqual([]);
  });

  it('counts an attendee without an email as invalid and goes on', () => {
    const result = eventObservations('personal', [event({ attendees: [{ email: 'owner@example.com', self: true }, { displayName: 'No mail' }, { email: 'jane@acme.com' }] })], OWNER, TZ);
    expect(emails(result.observations.map((each) => each.address))).toEqual(['jane@acme.com']);
    expect(result.skipped.invalid).toBe(1);
  });

});

describe('the store under repeated, late and odd reads', () => {
  it('counts a mail that is read twice once, and its name once', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    recordObservation(d, observation('jane@acme.com', 'Jane'), now);
    const again = recordObservation(d, observation('JANE@acme.com', 'Jane'), now)!;
    expect(again).toMatchObject({ createdPerson: false, createdContact: false });
    const person = getPerson(d, again.personId, now)!;
    expect(person.mailCount).toBe(1);
    expect(person.names).toEqual([{ name: 'Jane', count: 1, lastSeenAt: '2026-10-10T16:00:00.000Z' }]);
  });

  it('throws on an invalid email and writes nothing of the batch', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    expect(() => recordObservations(d, [observation('jane@acme.com', 'Jane'), observation('bad address', null, { externalId: 'm-2' })], now)).toThrow();
    expect(searchPeople(d, { limit: 10 }, now).total).toBe(0);
  });

  it('keeps the organization of the newest contact when an older mail from another company is read late', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane', { at: '2026-10-10T16:00:00.000Z' }, { name: 'Acme', domain: 'acme.com' }), now)!;
    recordObservation(d, observation('jane@acme.com', 'Jane', { externalId: 'm-old', at: '2026-01-01T16:00:00.000Z' }, { name: 'Old', domain: 'old.com' }), now);
    expect(getPerson(d, personId, now)).toMatchObject({ organization: 'Acme', organizationDomain: 'acme.com' });
  });

  it('splits past and upcoming exactly at now', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00.000Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane', { kind: 'meeting', externalId: 'e-now', threadId: null, direction: null, role: 'attendee', at: now.toISOString() }), now)!;
    recordObservation(d, observation('jane@acme.com', 'Jane', { kind: 'meeting', externalId: 'e-next', threadId: null, direction: null, role: 'attendee', at: '2026-10-18T16:00:00.001Z' }), now);
    const person = getPerson(d, personId, now)!;
    expect(person.meetingCount).toBe(1);
    expect(person.lastContactAt).toBe(now.toISOString());
    expect(person.upcoming.map((each) => each.eventId)).toEqual(['e-next']);
    expect(person.nextMeetingAt).toBe('2026-10-18T16:00:00.001Z');
  });

  it('takes a cancelled meeting out of the upcoming list and the counts, and a later read that is not cancelled brings it back', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const meeting = { kind: 'meeting' as const, externalId: 'e1', threadId: null, direction: null, role: 'attendee' as const, at: '2026-10-21T17:00:00.000Z' };
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane', meeting), now)!;
    expect(cancelMeetings(d, 'personal', ['e1', 'unknown'], now)).toBe(1);
    expect(getPerson(d, personId, now)!.upcoming).toEqual([]);
    expect(cancelMeetings(d, 'school', ['e1'], now)).toBe(0);
    recordObservation(d, observation('jane@acme.com', 'Jane', meeting), now);
    expect(getPerson(d, personId, now)!.upcoming).toHaveLength(1);
  });

  it('cancels more events than the variable limit of one statement', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const ids = Array.from({ length: 1200 }, (_, i) => `e${i}`);
    expect(cancelMeetings(d, 'personal', ids, now)).toBe(0);
  });

  it('keeps the owner name when headers give other names', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane'), now)!;
    d.prepare("UPDATE people SET name = 'Janie', nameSource = 'owner' WHERE id = ?").run(personId);
    recordObservation(d, observation('jane@acme.com', 'Jane Doe', { externalId: 'm-2' }), now);
    expect(getPerson(d, personId, now)!.name).toBe('Janie');
  });

  it('treats search text with like wildcards as plain text', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    recordObservation(d, observation('jane@acme.com', 'Jane'), now);
    recordObservation(d, observation('j_ne@acme.com', 'J_ne', { externalId: 'm-2' }), now);
    expect(searchPeople(d, { q: '%', limit: 10 }, now).total).toBe(0);
    expect(searchPeople(d, { q: '_', limit: 10 }, now).people.map((each) => each.primaryEmail)).toEqual(['j_ne@acme.com']);
    expect(searchPeople(d, { q: "'; DROP TABLE people; --", limit: 10 }, now).total).toBe(0);
    expect(searchPeople(d, { q: '\\', limit: 10 }, now).total).toBe(0);
    expect(searchPeople(d, { limit: 10 }, now).total).toBe(2);
  });

  it('pages through people without a gap or a repeat when sorted by name with ties', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    for (let i = 0; i < 7; i++) recordObservation(d, observation(`p${i}@acme.com`, 'Same Name', { externalId: `m${i}` }), now);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = searchPeople(d, { sort: 'name', limit: 3, ...(cursor ? { cursor } : {}) }, now);
      seen.push(...page.people.map((each) => each.id));
      if (!page.next) break;
      cursor = page.next;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives an empty page for a cursor past the end', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    recordObservation(d, observation('jane@acme.com', 'Jane'), now);
    const cursor = Buffer.from(JSON.stringify({ o: 100 })).toString('base64url');
    expect(searchPeople(d, { limit: 10, cursor }, now)).toEqual({ people: [], next: null, total: 1 });
  });

  it('never changes or deletes a note, also with sql', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane'), now)!;
    const note = addNote(d, { personId, kind: 'note', text: '  likes tea  ', author: 'owner' }, now);
    expect(note.text).toBe('likes tea');
    expect(() => d.prepare('UPDATE person_notes SET text = ? WHERE id = ?').run('x', note.id)).toThrow(/append-only/);
    expect(() => d.prepare('DELETE FROM person_notes WHERE id = ?').run(note.id)).toThrow(/append-only/);
  });

  it('refuses a note that supersedes a note of another person', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const jane = recordObservation(d, observation('jane@acme.com', 'Jane'), now)!.personId;
    const bob = recordObservation(d, observation('bob@acme.com', 'Bob', { externalId: 'm-2' }), now)!.personId;
    const note = addNote(d, { personId: jane, kind: 'note', text: 'one', author: 'owner' }, now);
    expect(() => addNote(d, { personId: bob, kind: 'note', text: 'two', author: 'owner', supersedes: note.id }, now)).toThrow(/note not found/);
    expect(() => addNote(d, { personId: jane, kind: 'note', text: '   ', author: 'owner' }, now)).toThrow(/empty/);
  });

  it('shows the newest of two notes that supersede the same one only once each', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane'), now)!;
    const first = addNote(d, { personId, kind: 'preference', text: 'mornings', author: 'agent' }, now);
    addNote(d, { personId, kind: 'preference', text: 'afternoons', author: 'owner', supersedes: first.id }, new Date('2026-10-18T17:00:00Z'));
    const profile = getPerson(d, personId, now)!;
    expect(profile.preferences.map((each) => each.text)).toEqual(['afternoons']);
  });

  it('finds a person by an address in another case and with angle brackets, and nothing for junk', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    recordObservation(d, observation('jane@acme.com', 'Jane'), now);
    expect(findPersonByEmail(d, '<JANE@Acme.com>', now)?.primaryEmail).toBe('jane@acme.com');
    expect(findPersonByEmail(d, '%', now)).toBeUndefined();
  });

  it('opens an open thread only when the person wrote last and the owner did not answer', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane', { externalId: 'a', at: '2026-10-15T10:00:00.000Z' }), now)!;
    expect(getPerson(d, personId, now)!.openThreads).toHaveLength(1);
    // the owner answers to someone else in the thread, with jane only in the thread through her earlier mail.
    recordObservation(d, observation('bob@acme.com', 'Bob', { externalId: 'b', direction: 'out', role: 'to', at: '2026-10-15T11:00:00.000Z' }), now);
    expect(getPerson(d, personId, now)!.openThreads).toEqual([]);
  });

  it('keeps one thread id per account apart, so the same thread id in two accounts is two threads', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane', { externalId: 'a', at: '2026-10-15T10:00:00.000Z' }), now)!;
    recordObservation(d, observation('bob@acme.com', 'Bob', { account: 'school', externalId: 'b', direction: 'out', role: 'to', at: '2026-10-15T11:00:00.000Z' }), now);
    expect(getPerson(d, personId, now)!.openThreads).toHaveLength(1);
  });
});

describe('the builder never throws into the poll', () => {
  it('logs and goes on when the store fails', () => {
    const d = fresh();
    const lines: string[] = [];
    const logger = { ...silent, warn: (msg: string) => void lines.push(msg), child: () => logger };
    const builder = createPeopleBuilder({
      db: d,
      clock: () => new Date('2026-10-18T16:00:00Z'),
      logger,
      timeZone: TZ,
      store: {
        recordObservations: () => {
          throw new Error('disk full for jane@acme.com');
        },
        cancelMeetings: () => 0,
      },
    });
    expect(() => builder.observeMail('personal', [message({ From: 'jane@acme.com' })])).not.toThrow();
    expect(lines).toEqual(['people builder failed']);
  });

  it('does not throw for a time zone that does not exist', () => {
    const d = fresh();
    const builder = createPeopleBuilder({ db: d, clock: () => new Date('2026-10-18T16:00:00Z'), logger: silent, timeZone: 'Mars/Olympus' });
    expect(() => builder.observeEvents('personal', [event({ start: { date: '2026-10-21' } })])).not.toThrow();
  });

  it('writes a mail that comes in two polls once', () => {
    const d = fresh();
    d.prepare("INSERT INTO google_accounts (alias, email, updatedAt) VALUES ('personal', 'owner@example.com', 'x')").run();
    const now = new Date('2026-10-18T16:00:00Z');
    const builder = createPeopleBuilder({ db: d, clock: () => now, logger: silent, timeZone: TZ });
    const mail = message({ From: 'Jane <jane@acme.com>', To: 'owner@example.com' });
    builder.observeMail('personal', [mail]);
    builder.observeMail('personal', [mail, mail]);
    const page = searchPeople(d, { limit: 10 }, now);
    expect(page.total).toBe(1);
    expect(page.people[0]!.mailCount).toBe(1);
  });

  it('marks the meeting rows of a bare cancel in a sync list as cancelled', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const builder = createPeopleBuilder({ db: d, clock: () => now, logger: silent, timeZone: TZ, ownerEmails: ['owner@example.com'] });
    builder.observeEvents('personal', [event({})]);
    expect(searchPeople(d, { limit: 10 }, now).people[0]!.nextMeetingAt).toBe('2026-10-21T17:00:00.000Z');
    builder.observeEvents('personal', [{ id: 'e1', status: 'cancelled' }]);
    expect(searchPeople(d, { limit: 10 }, now).people[0]!.nextMeetingAt).toBeNull();
  });
});

describe('the findings of the review', () => {
  it('gives no person from an event that the owner declined', () => {
    const declined = event({
      attendees: [
        { email: 'owner@example.com', self: true, responseStatus: 'declined' },
        { email: 'jane@acme.com', responseStatus: 'accepted' },
      ],
    });
    const result = eventObservations('personal', [declined], OWNER, TZ);
    expect(result.observations.every((each) => each.contact.cancelled)).toBe(true);
  });

  it('makes no person and no upcoming meeting from a stranger invite that the owner declined, and cancels the meeting of a known person', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const builder = createPeopleBuilder({ db: d, clock: () => now, logger: silent, timeZone: TZ, ownerEmails: ['owner@example.com'] });
    builder.observeMail('personal', [message({ From: 'Bob <bob@acme.com>', To: 'owner@example.com' })]);
    const spam = event({
      id: 'spam',
      organizer: { email: 'stranger@spam.example' },
      attendees: [
        { email: 'owner@example.com', self: true, responseStatus: 'declined' },
        { email: 'stranger@spam.example', responseStatus: 'accepted' },
        { email: 'bob@acme.com', responseStatus: 'accepted' },
      ],
    });
    builder.observeEvents('personal', [spam]);
    const page = searchPeople(d, { limit: 10 }, now);
    expect(page.people.map((each) => each.primaryEmail)).toEqual(['bob@acme.com']);
    expect(page.people[0]!.nextMeetingAt).toBeNull();
    expect(getPerson(d, page.people[0]!.id, now)!.upcoming).toEqual([]);
  });

  it('does not show one meeting twice when it is on the calendars of two accounts of the owner', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const meeting = { kind: 'meeting' as const, externalId: 'shared-event', threadId: null, direction: null, role: 'attendee' as const, at: '2026-10-21T17:00:00.000Z' };
    const { personId } = recordObservation(d, observation('jane@acme.com', 'Jane', { ...meeting, account: 'personal' }), now)!;
    recordObservation(d, observation('jane@acme.com', 'Jane', { ...meeting, account: 'school' }), now);
    expect(getPerson(d, personId, now)!.upcoming).toHaveLength(1);
    // once it is past, it counts once.
    const later = new Date('2026-10-22T16:00:00Z');
    expect(getPerson(d, personId, later)!).toMatchObject({ meetingCount: 1 });
    expect(getPerson(d, personId, later)!.recentMeetings).toHaveLength(1);
  });

  it('does not take the owner as a person when the owner writes from a plus address of their own mailbox', () => {
    const result = mailObservations('personal', message({ From: 'jane@acme.com', To: 'owner+receipts@example.com' }), OWNER);
    expect(emails(result.observations.map((each) => each.address))).toEqual(['jane@acme.com']);
    const sent = mailObservations('personal', message({ From: 'owner+lists@example.com', To: 'jane@acme.com' }), OWNER);
    expect(sent.observations[0]!.contact.direction).toBe('out');
  });

  it('matches a name with accents without case', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    recordObservation(d, observation('elodie@acme.com', 'Élodie Ødegaard'), now);
    expect(searchPeople(d, { q: 'élodie', limit: 10 }, now).total).toBe(1);
    expect(searchPeople(d, { q: 'ØDEGAARD', limit: 10 }, now).total).toBe(1);
  });

  it('refuses a sort that is an inherited object key', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    recordObservation(d, observation('jane@acme.com', 'Jane'), now);
    expect(searchPeople(d, { limit: 10, sort: 'constructor' as never }, now).total).toBe(1);
  });

  it('leaves out a calendar invitation mail that google sent for the organizer', () => {
    const invite = message({
      From: 'Jane Doe <jane@acme.com>',
      To: 'owner@example.com',
      Sender: 'Google Calendar <calendar-notification@google.com>',
      Subject: 'Invitation: Sync @ Tue Oct 21, 2026 10am',
    });
    const result = mailObservations('personal', invite, OWNER);
    expect(result.observations).toEqual([]);
    expect(result.skipped).toEqual({ calendar_mail: 1 });
    const byId = mailObservations('personal', message({ From: 'jane@acme.com', To: 'owner@example.com', 'Message-ID': '<calendar-1a2b3c@google.com>' }), OWNER);
    expect(byId.skipped).toEqual({ calendar_mail: 1 });
  });

  it('makes no person from the recipients of a mail from a no-reply or notification sender', () => {
    for (const from of ['noreply@school.example', 'notify@updates.tool.example']) {
      const result = mailObservations('personal', message({ From: from, To: 'owner@example.com', Cc: 'Jane Prof <jane@school.example>' }), OWNER);
      expect(result.observations, from).toEqual([]);
    }
    expect(mailObservations('personal', message({ From: 'noreply@school.example', Cc: 'jane@school.example' }), OWNER).skipped).toEqual({ no_reply: 1 });
  });

  it('treats an unquoted name with a via comment as a notification', () => {
    const result = mailObservations('personal', message({ From: 'Jane (via Slack) <jane@x.com>', To: 'owner@example.com' }), OWNER);
    expect(result.observations).toEqual([]);
    expect(result.skipped).toEqual({ notification: 1 });
  });

  it('counts a send-as alias of the owner as the owner', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    d.prepare("INSERT INTO people_accounts (account, aliases, updatedAt) VALUES ('personal', ?, 'x')").run(JSON.stringify(['me@alias.example']));
    const builder = createPeopleBuilder({ db: d, clock: () => now, logger: silent, timeZone: TZ, ownerEmails: ['owner@example.com'] });
    const out = builder.observeMail('personal', [message({ From: 'Me <me@alias.example>', To: 'jane@acme.com' })]);
    expect(out.observations.map((each) => [each.address.email, each.contact.direction])).toEqual([['jane@acme.com', 'out']]);
    expect(out.skipped).toEqual({ owner: 1 });
  });

  it('cancels the meeting of a guest who was taken off the event', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const builder = createPeopleBuilder({ db: d, clock: () => now, logger: silent, timeZone: TZ, ownerEmails: ['owner@example.com'] });
    const guests = [{ email: 'owner@example.com', self: true }, { email: 'jane@acme.com' }, { email: 'bob@acme.com' }];
    builder.observeEvents('personal', [event({ attendees: guests })]);
    builder.observeEvents('personal', [event({ attendees: guests.filter((each) => each.email !== 'bob@acme.com') })]);
    expect(findPersonByEmail(d, 'bob@acme.com', now)!.nextMeetingAt).toBeNull();
    expect(findPersonByEmail(d, 'jane@acme.com', now)!.nextMeetingAt).toBe('2026-10-21T17:00:00.000Z');
    // when bob is put back, the meeting comes back.
    builder.observeEvents('personal', [event({ attendees: guests })]);
    expect(findPersonByEmail(d, 'bob@acme.com', now)!.nextMeetingAt).toBe('2026-10-21T17:00:00.000Z');
  });

  it('adds a meeting of more than 15 attendees only to people that are known already', () => {
    const d = fresh();
    const now = new Date('2026-10-18T16:00:00Z');
    const builder = createPeopleBuilder({ db: d, clock: () => now, logger: silent, timeZone: TZ, ownerEmails: ['owner@example.com'] });
    builder.observeMail('personal', [message({ From: 'p3@acme.com', To: 'owner@example.com' })]);
    const attendees = [{ email: 'owner@example.com', self: true }, ...Array.from({ length: 19 }, (_, i) => ({ email: `p${i}@acme.com` }))];
    builder.observeEvents('personal', [event({ attendees })]);
    const page = searchPeople(d, { limit: 50 }, now);
    expect(page.people.map((each) => each.primaryEmail)).toEqual(['p3@acme.com']);
    expect(page.people[0]!.nextMeetingAt).toBe('2026-10-21T17:00:00.000Z');
    // a meeting of 15 makes people as before.
    builder.observeEvents('personal', [event({ id: 'e2', attendees: attendees.slice(0, 15) })]);
    expect(searchPeople(d, { limit: 50 }, now).total).toBe(14);
  });

  it('logs only the kind of a store error, never its text, and says that the write failed', () => {
    const d = fresh();
    const fields: unknown[] = [];
    const logger = { ...silent, warn: (_msg: string, data?: unknown) => void fields.push(data), child: () => logger };
    const builder = createPeopleBuilder({
      db: d,
      clock: () => new Date('2026-10-18T16:00:00Z'),
      logger,
      timeZone: TZ,
      store: {
        recordObservations: () => {
          throw Object.assign(new Error('UNIQUE failed for jane@acme.com'), { code: 'ERR_SQLITE_ERROR' });
        },
        cancelMeetings: () => 0,
      },
    });
    expect(builder.observeMail('personal', [message({ From: 'jane@acme.com' })]).failed).toBe(true);
    expect(JSON.stringify(fields)).not.toContain('jane@acme.com');
    expect(fields).toEqual([{ account: 'personal', count: 1, error: 'Error', code: 'ERR_SQLITE_ERROR' }]);
  });
});

describe('one human at two addresses', () => {
  const now = new Date('2026-10-18T16:00:00Z');
  const school = { name: 'Berkeley', domain: 'berkeley.edu' };

  it('attaches a new address to the one person with the same full name at the same organization', () => {
    const d = fresh();
    const first = recordObservation(d, observation('jdoe@berkeley.edu', 'Jane Doe', {}, school), now)!;
    const sub = recordObservation(d, observation('jdoe@hkn.eecs.berkeley.edu', 'jane doe', { externalId: 'm-2' }, school), now)!;
    expect(sub.personId).toBe(first.personId);
    expect(sub.createdPerson).toBe(false);
    const profile = getPerson(d, first.personId, now)!;
    expect(profile.primaryEmail).toBe('jdoe@berkeley.edu');
    expect(profile.emails).toHaveLength(2);
    expect(profile.mailCount).toBe(2);
  });

  it('never attaches an address at a personal domain by name alone', () => {
    const d = fresh();
    // two different people with one common name, both at gmail, stay two people.
    const one = recordObservation(d, observation('mchen1@gmail.com', 'Michael Chen', {}), now)!;
    const other = recordObservation(d, observation('mchen.other@gmail.com', 'Michael Chen', { externalId: 'm-2' }), now)!;
    expect(other.createdPerson).toBe(true);
    expect(other.personId).not.toBe(one.personId);
    expect(getPerson(d, one.personId, now)!.emails).toEqual(['mchen1@gmail.com']);
    expect(getPerson(d, other.personId, now)!.emails).toEqual(['mchen.other@gmail.com']);
    // a gmail address with the name of the one person at a company does not join that person either.
    const work = recordObservation(d, observation('jdoe@berkeley.edu', 'Jane Doe', { externalId: 'm-3' }, school), now)!;
    const personal = recordObservation(d, observation('jane.doe@gmail.com', 'Jane Doe', { externalId: 'm-4' }), now)!;
    expect(personal.createdPerson).toBe(true);
    expect(personal.personId).not.toBe(work.personId);
    expect(getPerson(d, work.personId, now)!.emails).toEqual(['jdoe@berkeley.edu']);
    // and a company address does not join a person whose only address is at gmail.
    recordObservation(d, observation('ana.ruiz@gmail.com', 'Ana Ruiz', { externalId: 'm-5' }), now);
    expect(recordObservation(d, observation('ana.ruiz@acme.com', 'Ana Ruiz', { externalId: 'm-6' }, { name: 'Acme', domain: 'acme.com' }), now)!.createdPerson).toBe(true);
  });

  it('does not attach a one-word name, another organization, or a name that two people share', () => {
    const d = fresh();
    recordObservation(d, observation('jane@acme.com', 'Jane', {}, { name: 'Acme', domain: 'acme.com' }), now);
    expect(recordObservation(d, observation('jane@gmail.com', 'Jane', { externalId: 'm-2' }), now)!.createdPerson).toBe(true);
    recordObservation(d, observation('sam.lee@acme.com', 'Sam Lee', { externalId: 'm-3' }, { name: 'Acme', domain: 'acme.com' }), now);
    expect(recordObservation(d, observation('sam.lee@globex.com', 'Sam Lee', { externalId: 'm-4' }, { name: 'Globex', domain: 'globex.com' }), now)!.createdPerson).toBe(true);
    // two people are named Sam Lee now, so a third address of that name stays apart.
    expect(recordObservation(d, observation('sam@gmail.com', 'Sam Lee', { externalId: 'm-5' }), now)!.createdPerson).toBe(true);
  });

  it('merges two people for the owner, keeps the notes of both, and finds the person by the old id', () => {
    const d = fresh();
    const a = recordObservation(d, observation('maya@northwind.example', 'Maya L', { externalId: 'm-1' }, { name: 'Northwind', domain: 'northwind.example' }), now)!;
    const b = recordObservation(d, observation('m.lindqvist@other.example', 'Maya Lindqvist', { externalId: 'm-2', at: '2026-10-12T16:00:00.000Z' }), now)!;
    // the same mail, seen at both addresses.
    recordObservation(d, observation('m.lindqvist@other.example', 'Maya Lindqvist', { externalId: 'm-1' }), now);
    addNote(d, { personId: b.personId, kind: 'preference', text: 'prefers mornings', author: 'owner' }, now);
    expect(mergePeople(d, a.personId, b.personId, now)).toBe(a.personId);
    const profile = getPerson(d, a.personId, now)!;
    expect(profile.emails).toEqual(['maya@northwind.example', 'm.lindqvist@other.example']);
    expect(profile.mailCount).toBe(2);
    expect(profile.preferences.map((each) => each.text)).toEqual(['prefers mornings']);
    expect(profile.names.map((each) => [each.name, each.count])).toEqual([
      ['Maya Lindqvist', 2],
      ['Maya L', 1],
    ]);
    expect(getPerson(d, b.personId, now)!.id).toBe(a.personId);
    expect(searchPeople(d, { limit: 10 }, now).total).toBe(1);
    expect(findPersonByEmail(d, 'm.lindqvist@other.example', now)!.id).toBe(a.personId);
    // a note for the old id goes to the person that stays.
    addNote(d, { personId: b.personId, kind: 'note', text: 'met in Oslo', author: 'agent' }, now);
    expect(getPerson(d, a.personId, now)!.notes.map((each) => each.text)).toEqual(['met in Oslo']);
    expect(() => mergePeople(d, a.personId, b.personId, now)).toThrow(InvalidMerge);
    expect(() => mergePeople(d, a.personId, 999, now)).toThrow(PersonNotFound);
  });
});
