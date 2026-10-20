import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { parseWhen, personKey, validEmail } from './shared.js';
import {
  appendDelegationEvent,
  createDelegation,
  getDelegation,
  listDelegationEvents,
  listDelegations,
  listDue,
  listFollowUpsDue,
  listWaiting,
  updateDelegation,
} from './store.js';
import { getDelegation as publicGet, listDue as publicDue, listWaiting as publicWaiting } from './index.js';

// tests that try to break the desk store and the shared rules: time zones and day boundaries, odd text, the rules of
// the status and the append-only history.

const NOW = new Date('2026-10-20T17:00:00.000Z');
const D = 24 * 3_600_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const LA = 'America/Los_Angeles';

let db: Db | undefined;
const open = () => (db = openDb(':memory:'));
afterEach(() => {
  db?.close();
  db = undefined;
});

const made = (target: Db, input: Partial<Parameters<typeof createDelegation>[1]> = {}, at = NOW) => {
  const result = createDelegation(target, { title: 'Book the flights', createdBy: 'agent', ...input }, { actor: 'agent', runId: 'run-1' }, at);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const kinds = (target: Db, id: number) => listDelegationEvents(target, id).map((each) => each.kind);

describe('parseWhen at the edges of the calendar', () => {
  it('reads a bare due day as 23:59 local on both sides of the end of daylight saving time', () => {
    // pdt on saturday, pst on sunday november 1, 2026.
    expect(parseWhen('2026-10-31', LA, 'due')).toEqual({ ok: true, iso: '2026-11-01T06:59:00.000Z' });
    expect(parseWhen('2026-11-01', LA, 'due')).toEqual({ ok: true, iso: '2026-11-02T07:59:00.000Z' });
    expect(parseWhen('2026-11-01', LA, 'followUp')).toEqual({ ok: true, iso: '2026-11-01T17:00:00.000Z' });
  });

  it('reads a bare day on the day that daylight saving time starts', () => {
    expect(parseWhen('2027-03-14', LA, 'followUp')).toEqual({ ok: true, iso: '2027-03-14T16:00:00.000Z' });
    expect(parseWhen('2027-03-14', LA, 'due')).toEqual({ ok: true, iso: '2027-03-15T06:59:00.000Z' });
  });

  it('gives a real instant for a local time inside the gap of the spring change', () => {
    const parsed = parseWhen('2027-03-14 02:30', LA, 'due');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // 02:30 does not exist that day. the time lands within an hour of it, never on another day.
      const ms = Date.parse(parsed.iso);
      expect(ms).toBeGreaterThanOrEqual(Date.parse('2027-03-14T09:30:00.000Z'));
      expect(ms).toBeLessThanOrEqual(Date.parse('2027-03-14T10:30:00.000Z'));
    }
  });

  it('takes a leap day only in a leap year', () => {
    expect(parseWhen('2028-02-29', LA, 'due').ok).toBe(true);
    expect(parseWhen('2027-02-29', LA, 'due')).toMatchObject({ ok: false, error: '2027-02-29 is not a day of the calendar' });
    expect(parseWhen('2027-02-29 10:00', LA, 'due').ok).toBe(false);
    expect(parseWhen('2027-02-29T10:00:00Z', LA, 'due').ok).toBe(false);
  });

  it('reads a day in a time zone east of utc as that local day', () => {
    // 09:00 in tokyo on october 21 is 00:00 utc that day.
    expect(parseWhen('2026-10-21', 'Asia/Tokyo', 'followUp')).toEqual({ ok: true, iso: '2026-10-21T00:00:00.000Z' });
    // 23:59 in kiritimati (utc+14) is the morning before in utc.
    expect(parseWhen('2026-10-21', 'Pacific/Kiritimati', 'due')).toEqual({ ok: true, iso: '2026-10-21T09:59:00.000Z' });
  });

  it('keeps the instant of an iso time with an offset, whatever the app time zone', () => {
    expect(parseWhen('2026-10-21T09:00:00+09:00', LA, 'due')).toEqual({ ok: true, iso: '2026-10-21T00:00:00.000Z' });
    expect(parseWhen('2026-10-21T09:00:00.123-07:00', 'Asia/Tokyo', 'due')).toEqual({ ok: true, iso: '2026-10-21T16:00:00.123Z' });
    expect(parseWhen('  2026-10-21T09:00Z  ', LA, 'due')).toEqual({ ok: true, iso: '2026-10-21T09:00:00.000Z' });
  });

  it('refuses text that is not a time', () => {
    for (const bad of ['', '   ', 'tomorrow', '2026-13-01', '2026-10-32', '2026-10-21 24:00', '2026-10-21 9:00', '2026-10-21T09:00+9', '2026/10/21', '20261021', '2026-10-21\n09:00', '2026-10-21T25:00:00Z']) {
      const parsed = parseWhen(bad, LA, 'due');
      expect(parsed.ok, bad).toBe(false);
    }
  });

  it('reads a local time with a space or a T, with CRLF or tabs around it', () => {
    expect(parseWhen('2026-10-21 08:15', LA, 'due')).toEqual({ ok: true, iso: '2026-10-21T15:15:00.000Z' });
    expect(parseWhen('\t2026-10-21T08:15\r\n', LA, 'due')).toEqual({ ok: true, iso: '2026-10-21T15:15:00.000Z' });
  });
});

describe('personKey and validEmail with odd text', () => {
  it('keys an email without case, and a name with single spaces', () => {
    expect(personKey({ name: 'Dana', email: '  DANA@Landlord.Example ' })).toBe('dana@landlord.example');
    expect(personKey({ name: '  Dana \t\r\n Park ' })).toBe('dana park');
    expect(personKey({ name: '   ', email: '   ' })).toBeNull();
    expect(personKey(null)).toBeNull();
  });

  it('refuses a header line break, a mailbox list and a display name as an email', () => {
    expect(validEmail('dana@landlord.example')).toBe(true);
    expect(validEmail(' Dana@Landlord.Example ')).toBe(true);
    for (const bad of ['dana@landlord.example\r\nBcc: eve@evil.example', 'dana@landlord.example, eve@evil.example', 'Dana <dana@landlord.example>', 'dana', '@landlord.example', 'dana@', 'dana@@landlord.example']) {
      expect(validEmail(bad), bad).toBe(false);
    }
  });
});

describe('the store with hostile or odd input', () => {
  it('keeps a title with quotes, sql and unicode as plain text', () => {
    const target = open();
    const title = `Robert'); DROP TABLE delegations;-- "x" 🚀 Zürich`;
    const d = made(target, { title });
    expect(getDelegation(target, d.id)!.title).toBe(title);
    expect(listDelegations(target).map((each) => each.title)).toEqual([title]);
  });

  it('matches % _ and \\ in q as plain characters', () => {
    const target = open();
    made(target, { title: 'Pay 100% of the bill' });
    made(target, { title: 'Pay 100 of the bill' });
    made(target, { title: 'Rename file_a' });
    made(target, { title: 'Rename fileXa' });
    made(target, { title: 'Path C:\\temp' });
    expect(listDelegations(target, { q: '100%' }).map((each) => each.title)).toEqual(['Pay 100% of the bill']);
    expect(listDelegations(target, { q: 'file_a' }).map((each) => each.title)).toEqual(['Rename file_a']);
    expect(listDelegations(target, { q: 'c:\\temp' }).map((each) => each.title)).toEqual(['Path C:\\temp']);
    expect(listDelegations(target, { q: '%' }).map((each) => each.title)).toEqual(['Pay 100% of the bill']);
  });

  it('matches q in the details and the next step without case, also across CRLF text', () => {
    const target = open();
    made(target, { title: 'One', details: 'line one\r\nCall The BANK\r\n' });
    made(target, { title: 'Two', nextStep: 'Ask the BANK' });
    made(target, { title: 'Three' });
    expect(listDelegations(target, { q: 'bank' }).map((each) => each.title)).toEqual(['One', 'Two']);
  });

  it('trims a link ref and its account, so one link with spaces is not a second row', () => {
    const target = open();
    const d = made(target, { links: [{ kind: 'thread', ref: ' t-1 ', account: ' personal ' }] });
    expect(d.links).toEqual([{ kind: 'thread', ref: 't-1', account: 'personal', label: null, href: null }]);
    const again = updateDelegation(target, d.id, { addLinks: [{ kind: 'thread', ref: 't-1', account: 'personal' }] }, { actor: 'owner' }, later(1000));
    expect(again.ok && again.value.links).toHaveLength(1);
    expect(kinds(target, d.id)).toEqual(['created', 'link_added']);
    // a removal with spaces finds it too.
    const removed = updateDelegation(target, d.id, { removeLinks: [{ kind: 'thread', ref: ' t-1 ', account: ' personal ' }] }, { actor: 'owner' }, later(2000));
    expect(removed.ok && removed.value.links).toEqual([]);
    expect(kinds(target, d.id)).toEqual(['created', 'link_added', 'link_removed']);
  });

  it('gives the same thread ref in two accounts two links', () => {
    const target = open();
    const d = made(target, {
      links: [
        { kind: 'thread', ref: 't-1', account: 'personal' },
        { kind: 'thread', ref: 't-1', account: 'school' },
      ],
    });
    expect(d.links.map((each) => each.account)).toEqual(['personal', 'school']);
  });

  it('drops the account of a run or a doc link', () => {
    const target = open();
    const d = made(target, { links: [{ kind: 'run', ref: 'run-9', account: 'personal' } as never] });
    expect(d.links[0]).toMatchObject({ kind: 'run', ref: 'run-9', account: null, href: 'runs/run-9' });
  });

  it('escapes a link ref in its href', () => {
    const target = open();
    const d = made(target, { links: [{ kind: 'doc', ref: '../../etc/passwd?x=1#y' }] });
    expect(d.links[0]!.href).toBe('docs/..%2F..%2Fetc%2Fpasswd%3Fx%3D1%23y');
  });

  it('removes the person and the wait with a move out of waiting, and keeps the history of each step', () => {
    const target = open();
    const d = made(target, { waitingOn: { name: 'Dana' }, nextFollowUpAt: later(D).toISOString() });
    expect(d).toMatchObject({ status: 'waiting', waitingSince: NOW.toISOString() });
    // clearing the person alone breaks the rule of waiting.
    expect(updateDelegation(target, d.id, { waitingOn: null }, { actor: 'owner' }, later(1))).toMatchObject({ ok: false, status: 400 });
    const moved = updateDelegation(target, d.id, { waitingOn: null, status: 'open' }, { actor: 'owner' }, later(1000));
    expect(moved.ok && moved.value).toMatchObject({ status: 'open', waitingOn: null, waitingSince: null });
    expect(kinds(target, d.id)).toEqual(['created', 'waiting_on', 'status']);
  });

  it('restarts the wait for a new person while waiting', () => {
    const target = open();
    const d = made(target, { waitingOn: { email: 'dana@landlord.example' } });
    const next = updateDelegation(target, d.id, { waitingOn: { email: 'lee@school.example' } }, { actor: 'owner' }, later(D));
    expect(next.ok && next.value).toMatchObject({ status: 'waiting', waitingSince: later(D).toISOString() });
    // the same person in another case is not a change.
    const same = updateDelegation(target, d.id, { waitingOn: { email: 'LEE@School.Example ' } }, { actor: 'owner' }, later(2 * D));
    expect(same.ok && same.value.waitingSince).toBe(later(D).toISOString());
    expect(kinds(target, d.id)).toEqual(['created', 'waiting_on']);
  });

  it('clears the follow-up when done, takes none while closed, and clears closedAt when it opens again', () => {
    const target = open();
    const d = made(target, { nextFollowUpAt: later(D).toISOString() });
    const done = updateDelegation(target, d.id, { status: 'done' }, { actor: 'owner' }, later(1000));
    expect(done.ok && done.value).toMatchObject({ status: 'done', nextFollowUpAt: null, closedAt: later(1000).toISOString() });
    expect(updateDelegation(target, d.id, { nextFollowUpAt: later(2 * D).toISOString() }, { actor: 'owner' }, later(2000))).toMatchObject({ ok: false, status: 409 });
    // dropped after done keeps a closed time, the time of the new status.
    const dropped = updateDelegation(target, d.id, { status: 'dropped' }, { actor: 'owner' }, later(3000));
    expect(dropped.ok && dropped.value.closedAt).toBe(later(3000).toISOString());
    const reopened = updateDelegation(target, d.id, { status: 'open', nextFollowUpAt: later(2 * D).toISOString() }, { actor: 'owner' }, later(4000));
    expect(reopened.ok && reopened.value).toMatchObject({ status: 'open', closedAt: null, nextFollowUpAt: later(2 * D).toISOString() });
    expect(listFollowUpsDue(target, later(3 * D)).map((each) => each.id)).toEqual([d.id]);
  });

  it('writes no row and keeps updatedAt for a patch of the same values, empty lists and a blank note', () => {
    const target = open();
    const d = made(target, { title: 'Same', details: 'x', waitingOn: { name: 'Dana' } });
    const result = updateDelegation(
      target,
      d.id,
      { title: '  Same  ', details: ' x ', waitingOn: { name: ' Dana ' }, status: 'waiting', addLinks: [], removeLinks: [{ kind: 'run', ref: 'nope' }], note: '   ' },
      { actor: 'owner' },
      later(D),
    );
    expect(result.ok && result.value.updatedAt).toBe(NOW.toISOString());
    expect(kinds(target, d.id)).toEqual(['created']);
  });

  it('gives 404 for a missing id and writes nothing', () => {
    const target = open();
    expect(updateDelegation(target, 999, { note: 'x' }, { actor: 'owner' }, NOW)).toEqual({ ok: false, status: 404, error: 'delegation #999 not found' });
    expect(Number(target.prepare('SELECT count(*) AS n FROM delegation_events').get()!.n)).toBe(0);
  });

  it('refuses an event row for a delegation that does not exist', () => {
    const target = open();
    expect(() => appendDelegationEvent(target, { delegationId: 42, kind: 'note', actor: 'owner', text: 'x' }, NOW)).toThrow();
  });

  it('refuses an unknown status and actor at the database', () => {
    const target = open();
    const d = made(target);
    expect(() => target.prepare("UPDATE delegations SET status = 'later' WHERE id = ?").run(d.id)).toThrow();
    expect(() => appendDelegationEvent(target, { delegationId: d.id, kind: 'note', actor: 'mallory' as never }, NOW)).toThrow();
  });

  it('keeps every history row against an update and a delete, also inside a transaction', () => {
    const target = open();
    const d = made(target);
    expect(() => target.prepare("UPDATE delegation_events SET text = 'x'").run()).toThrow(/append-only/);
    expect(() => target.prepare('DELETE FROM delegation_events').run()).toThrow(/append-only/);
    target.exec('BEGIN');
    expect(() => target.prepare('DELETE FROM delegation_events WHERE delegationId = ?').run(d.id)).toThrow(/append-only/);
    target.exec('ROLLBACK');
    expect(kinds(target, d.id)).toEqual(['created']);
  });

  it('shows a history row with damaged json data as empty data', () => {
    const target = open();
    const d = made(target);
    target
      .prepare("INSERT INTO delegation_events (delegationId, kind, actor, data, createdAt) VALUES (?, 'note', 'owner', ?, ?)")
      .run(d.id, '{not json', NOW.toISOString());
    target
      .prepare("INSERT INTO delegation_events (delegationId, kind, actor, data, createdAt) VALUES (?, 'note', 'owner', ?, ?)")
      .run(d.id, '[1,2]', NOW.toISOString());
    expect(listDelegationEvents(target, d.id).slice(1).map((each) => each.data)).toEqual([{}, {}]);
  });

  it('rolls the whole create back when a link breaks the database rules', () => {
    const target = open();
    expect(() => made(target, { links: [{ kind: 'video' as never, ref: 'x' }] })).toThrow();
    expect(Number(target.prepare('SELECT count(*) AS n FROM delegations').get()!.n)).toBe(0);
    expect(Number(target.prepare('SELECT count(*) AS n FROM delegation_events').get()!.n)).toBe(0);
  });
});

describe('the read api for the brief at its boundaries', () => {
  it('is exported from the index and only reads', () => {
    const target = open();
    const d = made(target, { dueAt: NOW.toISOString(), waitingOn: { name: 'Dana' } });
    const before = Number(target.prepare('SELECT total_changes() AS n').get()!.n);
    expect(publicGet(target, d.id)!.id).toBe(d.id);
    expect(publicDue(target, NOW).map((each) => each.id)).toEqual([d.id]);
    expect(publicWaiting(target).map((each) => each.id)).toEqual([d.id]);
    expect(Number(target.prepare('SELECT total_changes() AS n').get()!.n)).toBe(before);
  });

  it('counts a due time equal to until as due, and one a millisecond later as not due', () => {
    const target = open();
    const a = made(target, { title: 'A', dueAt: later(D).toISOString() });
    made(target, { title: 'B', dueAt: later(D + 1).toISOString() });
    expect(listDue(target, later(D)).map((each) => each.id)).toEqual([a.id]);
  });

  it('leaves out closed rows, and orders by due time with rows due only by follow-up last', () => {
    const target = open();
    const late = made(target, { title: 'late', dueAt: later(2 * D).toISOString() });
    const soon = made(target, { title: 'soon', dueAt: later(D).toISOString() });
    const follow = made(target, { title: 'follow', nextFollowUpAt: later(D).toISOString() });
    const closed = made(target, { title: 'closed', dueAt: later(D).toISOString() });
    updateDelegation(target, closed.id, { status: 'done' }, { actor: 'owner' }, NOW);
    expect(listDue(target, later(3 * D)).map((each) => each.id)).toEqual([soon.id, late.id, follow.id]);
  });

  it('gives the longest wait first in listWaiting, and no blocked or open row', () => {
    const target = open();
    const second = made(target, { title: 'second', waitingOn: { name: 'B' } }, later(2000));
    const first = made(target, { title: 'first', waitingOn: { name: 'A' } }, later(1000));
    const blocked = made(target, { title: 'blocked', waitingOn: { name: 'C' } });
    updateDelegation(target, blocked.id, { status: 'blocked' }, { actor: 'owner' }, NOW);
    made(target, { title: 'open' });
    expect(listWaiting(target).map((each) => each.id)).toEqual([first.id, second.id]);
  });

  it('gives empty lists on an empty desk', () => {
    const target = open();
    expect(listDue(target, later(365 * D))).toEqual([]);
    expect(listWaiting(target)).toEqual([]);
    expect(listDelegations(target, { statuses: [] })).toEqual([]);
  });
});
