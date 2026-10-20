import { afterEach, describe, expect, it } from 'vitest';
import { seedDesk } from '../../test/seed-desk.js';
import { openDb, type Db } from '../db/index.js';
import { parseWhen, personKey } from './shared.js';
import {
  appendDelegationEvent,
  createDelegation,
  getDelegationDetail,
  listDelegationEvents,
  listDelegations,
  listDue,
  listFollowUpsDue,
  listWaiting,
  updateDelegation,
} from './store.js';

const NOW = new Date('2026-10-13T01:00:00.000Z');
const D = 24 * 3_600_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);

let db: Db | undefined;
const open = () => (db = openDb(':memory:'));
afterEach(() => {
  db?.close();
  db = undefined;
});

const made = (target: Db, input: Partial<Parameters<typeof createDelegation>[1]> = {}) => {
  const result = createDelegation(target, { title: 'Book the flights', createdBy: 'agent', ...input }, { actor: 'agent', runId: 'run-1' }, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe('the desk store', () => {
  it('creates a delegation with its links and a created row', () => {
    const target = open();
    const delegation = made(target, { links: [{ kind: 'thread', ref: 't-1', account: 'personal' }, { kind: 'run', ref: 'run-1' }] });
    expect(delegation).toMatchObject({ id: 1, status: 'open', waitingOn: null, createdBy: 'agent', closedAt: null });
    expect(delegation.links).toEqual([
      { kind: 'thread', ref: 't-1', account: 'personal', label: null, href: null },
      { kind: 'run', ref: 'run-1', account: null, label: null, href: 'runs/run-1' },
    ]);
    expect(listDelegationEvents(target, 1).map((each) => each.kind)).toEqual(['created', 'link_added', 'link_added']);
  });

  it('starts a delegation with a person as waiting', () => {
    const target = open();
    const delegation = made(target, { waitingOn: { name: ' Dana ', email: 'Dana@Landlord.example' } });
    expect(delegation).toMatchObject({ status: 'waiting', waitingOn: { name: 'Dana', email: 'dana@landlord.example' }, waitingSince: NOW.toISOString() });
  });

  it('keeps the rules of the status', () => {
    const target = open();
    made(target);
    expect(updateDelegation(target, 1, { status: 'waiting' }, { actor: 'owner' }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(updateDelegation(target, 9, { status: 'done' }, { actor: 'owner' }, NOW)).toMatchObject({ ok: false, status: 404 });
    const waiting = updateDelegation(target, 1, { status: 'waiting', waitingOn: { email: 'sam@example.com' }, nextFollowUpAt: later(D).toISOString() }, { actor: 'agent' }, later(1));
    expect(waiting).toMatchObject({ ok: true, value: { status: 'waiting', waitingSince: later(1).toISOString() } });
    expect(updateDelegation(target, 1, { waitingOn: null }, { actor: 'owner' }, NOW)).toMatchObject({ ok: false, status: 400 });
    const done = updateDelegation(target, 1, { status: 'done', note: 'booked' }, { actor: 'agent' }, later(2));
    expect(done).toMatchObject({ ok: true, value: { status: 'done', closedAt: later(2).toISOString(), nextFollowUpAt: null, waitingSince: null } });
    expect(updateDelegation(target, 1, { nextFollowUpAt: later(D).toISOString() }, { actor: 'owner' }, NOW)).toMatchObject({ ok: false, status: 409 });
    const reopened = updateDelegation(target, 1, { status: 'open' }, { actor: 'owner' }, later(3));
    expect(reopened).toMatchObject({ ok: true, value: { status: 'open', closedAt: null } });
    expect(listDelegationEvents(target, 1).map((each) => `${each.kind}:${each.actor}`)).toEqual([
      'created:agent',
      'updated:agent',
      'waiting_on:agent',
      'status:agent',
      'updated:agent',
      'status:agent',
      'note:agent',
      'status:owner',
    ]);
  });

  it('writes no row for a patch that changes nothing', () => {
    const target = open();
    made(target, { nextStep: 'call' });
    updateDelegation(target, 1, { nextStep: 'call', status: 'open', removeLinks: [{ kind: 'run', ref: 'nope' }] }, { actor: 'owner' }, later(1));
    expect(listDelegationEvents(target, 1)).toHaveLength(1);
    expect(getDelegationDetail(target, 1)?.updatedAt).toBe(NOW.toISOString());
  });

  it('keeps the history append-only', () => {
    const target = open();
    made(target);
    appendDelegationEvent(target, { delegationId: 1, kind: 'note', text: 'a line', actor: 'owner' }, NOW);
    expect(() => target.prepare("UPDATE delegation_events SET text = 'changed'").run()).toThrow(/append-only/);
    expect(() => target.prepare('DELETE FROM delegation_events').run()).toThrow(/append-only/);
  });

  it('gives the read api of the seed', () => {
    const target = open();
    seedDesk(target, NOW);
    expect(listDue(target, NOW).map((each) => each.id)).toEqual([3]);
    expect(listDue(target, later(3 * 24 * 3_600_000)).map((each) => each.id)).toEqual([3, 1, 2, 8]);
    expect(listWaiting(target).map((each) => each.id)).toEqual([2, 3, 8]);
    expect(listFollowUpsDue(target, NOW).map((each) => each.id)).toEqual([3]);
    expect(listDelegations(target, { person: 'dana@landlord.example' }).map((each) => each.id)).toEqual([2]);
    expect(listDelegations(target, { q: 'DANA' }).map((each) => each.id)).toEqual([2, 8]);
    expect(listDelegations(target).map((each) => each.id)).toEqual([3, 1, 2, 4, 7, 8, 5, 6]);
    const lease = getDelegationDetail(target, 2)!;
    expect(lease).toMatchObject({ nudgeCount: 1, nextFollowUpAt: later(D).toISOString() });
    expect(lease.history.map((each) => each.kind)).toEqual(['created', 'link_added', 'follow_up_checked', 'nudge_drafted', 'note']);
    expect(lease.nudges.map((each) => each.gmailDraftId)).toEqual(['d-nudge-1']);
    expect(getDelegationDetail(target, 4)!.history.map((each) => each.kind)).toEqual(['created', 'link_added', 'updated', 'status']);
  });
});

describe('the desk rules', () => {
  it('reads due and follow-up times', () => {
    const tz = 'America/Los_Angeles';
    expect(parseWhen('2026-10-20', tz, 'due')).toEqual({ ok: true, iso: '2026-10-21T06:59:00.000Z' });
    expect(parseWhen('2026-10-20', tz, 'followUp')).toEqual({ ok: true, iso: '2026-10-20T16:00:00.000Z' });
    expect(parseWhen('2026-10-20 14:30', tz, 'due')).toEqual({ ok: true, iso: '2026-10-20T21:30:00.000Z' });
    expect(parseWhen('2026-10-20T14:30:00Z', tz, 'due')).toEqual({ ok: true, iso: '2026-10-20T14:30:00.000Z' });
    expect(parseWhen('2026-02-30', tz, 'due').ok).toBe(false);
    expect(parseWhen('next friday', tz, 'due').ok).toBe(false);
  });

  it('keys a person by email, then by name', () => {
    expect(personKey({ name: 'Dana Park', email: ' Dana@Example.com ' })).toBe('dana@example.com');
    expect(personKey({ name: '  Dana   Park ' })).toBe('dana park');
    expect(personKey(null)).toBeNull();
  });
});
