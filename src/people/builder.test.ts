import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { createPeopleBuilder, eventObservations, mailObservations, ownerAddresses, PEOPLE_HEADERS } from './builder.js';
import type { Observation } from './types.js';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures/people');
const mail = JSON.parse(readFileSync(join(FIXTURES, 'mail.json'), 'utf8')) as Record<string, gmail_v1.Schema$Message>;
const events = JSON.parse(readFileSync(join(FIXTURES, 'events.json'), 'utf8')) as Record<string, calendar_v3.Schema$Event>;

const OWNER = new Set(['owner@example.com']);
const TZ = 'America/Los_Angeles';

// the people of a result in a short form, so a test reads like the mail.
const people = (observations: Observation[]) => observations.map((each) => [each.address.email, each.address.name, each.contact.role, each.organization?.name ?? null]);

const fakeLogger = () => {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger: Logger = {
    debug: (msg, fields) => void lines.push([msg, fields]),
    info: (msg, fields) => void lines.push([msg, fields]),
    warn: (msg, fields) => void lines.push([msg, fields]),
    error: (msg, fields) => void lines.push([msg, fields]),
    child: () => logger,
  };
  return { logger, lines };
};

describe('ownerAddresses', () => {
  it('reads the emails of the google accounts and the config, in lower case', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO google_accounts (alias, email, updatedAt) VALUES ('personal', 'Owner@Example.com', 'x'), ('work', NULL, 'x')").run();
    expect([...ownerAddresses(db, [' Me@Work.org ', 'not an address'])].sort()).toEqual(['me@work.org', 'owner@example.com']);
    db.close();
  });
});

describe('mailObservations', () => {
  it('asks gmail for the headers it reads and no more', () => {
    expect(PEOPLE_HEADERS).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'Sender', 'Message-ID']);
  });

  it('makes the sender and the other recipients of an inbound mail, without the owner', () => {
    const result = mailObservations('personal', mail.inbound!, OWNER);
    expect(people(result.observations)).toEqual([
      ['jane.doe@mail.eu.acme.com', 'Doe, Jane', 'from', 'Acme'],
      ['bob@northgate.edu', 'Bob Stone', 'to', 'Northgate'],
      ['carol@gmail.com', 'Carol Diaz', 'cc', null],
    ]);
    expect(result.skipped).toEqual({ owner: 1 });
    expect(result.observations[0]!.organization).toEqual({ name: 'Acme', domain: 'acme.com' });
    expect(result.observations[0]!.contact).toEqual({
      kind: 'mail',
      account: 'personal',
      externalId: 'm-in',
      threadId: 't-1',
      direction: 'in',
      role: 'from',
      subject: 'Lunch next week?',
      at: new Date(1760900000000).toISOString(),
      endAt: null,
      cancelled: false,
    });
  });

  it('makes the recipients of a mail from the owner, with direction out', () => {
    const result = mailObservations('personal', mail.outbound!, OWNER);
    expect(people(result.observations)).toEqual([
      ['jane.doe@mail.eu.acme.com', 'Jane Doe', 'to', 'Acme'],
      ['bob@northgate.edu', null, 'cc', 'Northgate'],
    ]);
    expect(result.observations.every((each) => each.contact.direction === 'out')).toBe(true);
    expect(result.skipped).toEqual({ owner: 1, no_reply: 1 });
  });

  it('keeps only the sender of a mail to more than 20 people', () => {
    const result = mailObservations('personal', mail.wide!, OWNER);
    expect(people(result.observations)).toEqual([['dana@acme.com', 'Dana Lee', 'from', 'Acme']]);
    expect(result.skipped).toEqual({ too_many_recipients: 1 });
  });

  it('makes nobody from a list mail, and counts the mail once', () => {
    const result = mailObservations('personal', mail.list!, OWNER);
    expect(result).toEqual({ observations: [], skipped: { mailing_list: 1 } });
  });

  it('drops spam and drafts without a count', () => {
    expect(mailObservations('personal', mail.spam!, OWNER)).toEqual({ observations: [], skipped: {} });
    expect(mailObservations('personal', mail.draft!, OWNER)).toEqual({ observations: [], skipped: {} });
    expect(mailObservations('personal', { ...mail.inbound!, labelIds: ['TRASH'] }, OWNER)).toEqual({ observations: [], skipped: {} });
  });

  it('takes the date header when the internal date is missing, and skips a mail with neither', () => {
    const fromHeader = mailObservations('personal', mail.headerDate!, OWNER);
    expect(fromHeader.observations[0]!.contact.at).toBe('2025-10-19T18:53:20.000Z');
    expect(mailObservations('personal', mail.noDate!, OWNER)).toEqual({ observations: [], skipped: { invalid: 1 } });
    expect(mailObservations('personal', { ...mail.inbound!, id: null }, OWNER).skipped).toEqual({ invalid: 1 });
  });

  it('gives a null subject for an empty one', () => {
    const headers = mail.headerDate!.payload!.headers!;
    const result = mailObservations('personal', { ...mail.headerDate!, payload: { headers: [...headers, { name: 'Subject', value: '   ' }] } }, OWNER);
    expect(result.observations[0]!.contact.subject).toBeNull();
  });
});

describe('eventObservations', () => {
  it('makes the organizer and the attendees, without the owner and the room, and marks a decline', () => {
    const result = eventObservations('personal', [events.meeting!], OWNER, TZ);
    expect(people(result.observations)).toEqual([
      ['jane.doe@acme.com', 'Jane Doe', 'organizer', 'Acme'],
      ['bob@northgate.edu', null, 'attendee', 'Northgate'],
      ['carol@gmail.com', 'Carol Diaz', 'attendee', null],
    ]);
    expect(result.skipped).toEqual({ owner: 1, calendar_resource: 1 });
    expect(result.observations.map((each) => each.contact.cancelled)).toEqual([false, true, false]);
    expect(result.observations[0]!.contact).toEqual({
      kind: 'meeting',
      account: 'personal',
      externalId: 'e-meet',
      threadId: null,
      direction: null,
      role: 'organizer',
      subject: 'Project sync',
      at: '2026-10-21T17:00:00.000Z',
      endAt: '2026-10-21T17:30:00.000Z',
      cancelled: false,
    });
  });

  it('puts an all-day event at midnight in the time zone', () => {
    const result = eventObservations('personal', [events.allDay!], OWNER, TZ);
    expect(people(result.observations)).toEqual([['dana@acme.com', 'Dana Lee', 'attendee', 'Acme']]);
    expect(result.observations[0]!.contact.at).toBe('2026-11-02T08:00:00.000Z');
    expect(result.observations[0]!.contact.endAt).toBe('2026-11-03T08:00:00.000Z');
  });

  it('leaves out a meeting of more than 25 attendees, and counts it once', () => {
    const attendees = Array.from({ length: 30 }, (_, i) => ({ email: `p${i}@acme.com` }));
    const result = eventObservations('personal', [{ ...events.meeting!, id: 'e-big', attendees }], OWNER, TZ);
    expect(result).toEqual({ observations: [], skipped: { large_meeting: 1 } });
    const exactly = eventObservations('personal', [{ ...events.meeting!, id: 'e-25', attendees: attendees.slice(0, 25) }], OWNER, TZ);
    // 25 attendees and the organizer of the fixture, who is not in this list.
    expect(exactly.observations).toHaveLength(26);
  });

  it('makes nobody and counts nothing for a hold of the owner alone', () => {
    expect(eventObservations('personal', [events.hold!, events.groupHold!], OWNER, TZ)).toEqual({ observations: [], skipped: {} });
  });

  it('marks everyone of a cancelled event that still has attendees', () => {
    const result = eventObservations('personal', [events.cancelledFull!], OWNER, TZ);
    expect(people(result.observations)).toEqual([['dana@acme.com', null, 'organizer', 'Acme']]);
    expect(result.observations[0]!.contact.cancelled).toBe(true);
  });

  it('gives nothing for a bare cancelled event, and counts an event without a start as invalid', () => {
    expect(eventObservations('personal', [events.cancelled!], OWNER, TZ)).toEqual({ observations: [], skipped: {} });
    expect(eventObservations('personal', [events.noStart!], OWNER, TZ)).toEqual({ observations: [], skipped: { invalid: 1 } });
  });

  it('takes the owner from the address too, when self is not set', () => {
    const event = { ...events.meeting!, attendees: [{ email: 'OWNER@example.com' }, { email: 'dana@acme.com' }], organizer: { email: 'owner@example.com' } };
    const result = eventObservations('personal', [event], OWNER, TZ);
    expect(people(result.observations)).toEqual([['dana@acme.com', null, 'attendee', 'Acme']]);
    expect(result.skipped).toEqual({ owner: 1 });
  });
});

describe('createPeopleBuilder', () => {
  const setup = (store: { recordObservations: ReturnType<typeof vi.fn>; cancelMeetings: ReturnType<typeof vi.fn> }) => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO google_accounts (alias, email, updatedAt) VALUES ('personal', 'owner@example.com', 'x')").run();
    const { logger, lines } = fakeLogger();
    const now = new Date('2026-10-19T12:00:00Z');
    const builder = createPeopleBuilder({ db, clock: () => now, logger, timeZone: TZ, store: store as never });
    return { db, builder, lines, now };
  };

  it('writes the observations of a batch of mail in one call', () => {
    const store = { recordObservations: vi.fn(() => []), cancelMeetings: vi.fn(() => 0) };
    const { db, builder, now } = setup(store);
    const result = builder.observeMail('personal', [mail.inbound!, mail.list!, mail.outbound!]);
    expect(result.observations).toHaveLength(5);
    expect(result.skipped).toEqual({ owner: 2, mailing_list: 1, no_reply: 1 });
    expect(store.recordObservations).toHaveBeenCalledTimes(1);
    expect(store.recordObservations).toHaveBeenCalledWith(db, result.observations, now);
    expect(store.cancelMeetings).not.toHaveBeenCalled();
  });

  it('writes the events, and cancels the meetings of bare cancelled events', () => {
    const store = { recordObservations: vi.fn(() => []), cancelMeetings: vi.fn(() => 0) };
    const { db, builder, now } = setup(store);
    const result = builder.observeEvents('personal', [events.meeting!, events.cancelled!, events.hold!]);
    expect(result.observations).toHaveLength(3);
    expect(store.recordObservations).toHaveBeenCalledWith(db, result.observations, now);
    expect(store.cancelMeetings).toHaveBeenCalledWith(db, 'personal', ['e-cancelled'], now);
  });

  it('never throws when the store fails, and logs no address or subject', () => {
    const fail = () => {
      throw new Error('disk I/O error');
    };
    const store = { recordObservations: vi.fn(fail), cancelMeetings: vi.fn(fail) };
    const { builder, lines } = setup(store);
    expect(() => builder.observeMail('personal', [mail.inbound!])).not.toThrow();
    expect(() => builder.observeEvents('personal', [events.meeting!, events.cancelled!])).not.toThrow();
    expect(lines.map(([msg, fields]) => [msg, fields?.account, fields?.count])).toEqual([
      ['people builder failed', 'personal', 1],
      ['people builder failed', 'personal', 2],
    ]);
    const text = JSON.stringify(lines, (_, value: unknown) => (value instanceof Error ? value.message : value));
    expect(text).not.toMatch(/@|Lunch|Project sync/);
  });
});
