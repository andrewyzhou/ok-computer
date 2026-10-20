import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { DESK_MODULE, readDelegations } from './desk.js';

const END = new Date('2026-10-13T06:59:59.999Z');
const db = openDb(':memory:');

const row = (id: number, fields: Record<string, unknown> = {}) => ({ id, title: `job ${id}`, status: 'open', ...fields });

describe('brief delegations', () => {
  it('gives null without the desk module', async () => {
    const desk = new URL(DESK_MODULE.replace(/\.js$/, '.ts'), import.meta.url);
    // the desk track adds the module. until it does, the real loader finds nothing.
    if (!existsSync(desk)) expect(await readDelegations(db, END)).toBeNull();
    expect(await readDelegations(db, END, async () => ({}))).toBeNull();
    expect(await readDelegations(db, END, async () => ({ listDelegations: 'not a function' }))).toBeNull();
    expect(await readDelegations(db, END, async () => ({ listDelegations: () => 'not a list' }))).toBeNull();
  });

  it('gives null when the loader or the list throws', async () => {
    expect(
      await readDelegations(db, END, async () => {
        throw new Error('no such module');
      }),
    ).toBeNull();
    expect(
      await readDelegations(db, END, async () => ({
        listDelegations: () => {
          throw new Error('no such table');
        },
      })),
    ).toBeNull();
  });

  it('keeps the active delegations that are due, follow up or wait by the end of the day, sorted by due time', async () => {
    let given: unknown;
    const rows = [
      row(1, { dueAt: '2026-10-14T00:00:00.000Z' }),
      row(2, { status: 'waiting', waitingOn: 'dana@landlord.example', dueAt: '2026-10-20T00:00:00.000Z', extra: 'ignored' }),
      row(3, { status: 'blocked', dueAt: '2026-10-12T19:00:00.000Z', nextStep: 'call the office' }),
      row(4, { followUpAt: '2026-10-12T19:00:00.000Z' }),
      row(5, { status: 'done', dueAt: '2026-10-12T19:00:00.000Z' }),
      row(6, { status: 'dropped', waitingOn: 'sam' }),
      row(7, { status: 'unknown', dueAt: '2026-10-12T19:00:00.000Z' }),
      { id: 'eight', title: 'bad id', status: 'open', dueAt: '2026-10-12T19:00:00.000Z' },
      row(9, { title: 9, dueAt: '2026-10-12T19:00:00.000Z' }),
      row(10, { dueAt: '2026-10-12T18:00:00.000Z' }),
      row(11, { status: 'waiting', waitingOn: { name: null, email: 'office@example.edu' }, nextFollowUpAt: '2026-10-12T20:00:00.000Z' }),
      row(12, { dueAt: '2026-10-13T06:59:59.999Z' }),
      row(13, { dueAt: 'not a time' }),
      'not a row',
    ];
    const result = await readDelegations(db, END, async () => ({
      listDelegations: (each: unknown) => {
        given = each;
        return rows;
      },
    }));
    expect(given).toBe(db);
    expect(result).toEqual([
      { id: 10, title: 'job 10', status: 'open', nextStep: null, waitingOn: null, dueAt: '2026-10-12T18:00:00.000Z', followUpAt: null },
      { id: 3, title: 'job 3', status: 'blocked', nextStep: 'call the office', waitingOn: null, dueAt: '2026-10-12T19:00:00.000Z', followUpAt: null },
      { id: 12, title: 'job 12', status: 'open', nextStep: null, waitingOn: null, dueAt: '2026-10-13T06:59:59.999Z', followUpAt: null },
      { id: 2, title: 'job 2', status: 'waiting', nextStep: null, waitingOn: 'dana@landlord.example', dueAt: '2026-10-20T00:00:00.000Z', followUpAt: null },
      { id: 4, title: 'job 4', status: 'open', nextStep: null, waitingOn: null, dueAt: null, followUpAt: '2026-10-12T19:00:00.000Z' },
      { id: 11, title: 'job 11', status: 'waiting', nextStep: null, waitingOn: 'office@example.edu', dueAt: null, followUpAt: '2026-10-12T20:00:00.000Z' },
    ]);
  });

  it('takes an async list', async () => {
    const result = await readDelegations(db, END, async () => ({ listDelegations: async () => [row(1, { waitingOn: 'sam' })] }));
    expect(result).toEqual([{ id: 1, title: 'job 1', status: 'open', nextStep: null, waitingOn: 'sam', dueAt: null, followUpAt: null }]);
  });

  // this test runs only when the desk track is merged. it makes a delegation with the real desk store and reads it
  // with the default loader, so a change of the desk module that breaks the brief shows here.
  const deskFile = new URL(DESK_MODULE.replace(/\.js$/, '.ts'), import.meta.url);
  it.runIf(existsSync(deskFile))('reads a delegation that the real desk store made', async () => {
    const desk = (await import(/* @vite-ignore */ DESK_MODULE)) as {
      createDelegation: (db: unknown, input: Record<string, unknown>, by: Record<string, unknown>, now: Date) => { ok: boolean };
    };
    const own = openDb(':memory:');
    const made = desk.createDelegation(
      own,
      { title: 'Get the refund', waitingOn: { name: 'Dana', email: 'dana@example.com' }, dueAt: '2026-10-12T20:00:00.000Z', createdBy: 'owner' },
      { actor: 'owner' },
      new Date('2026-10-12T14:00:00.000Z'),
    );
    expect(made.ok).toBe(true);
    const got = await readDelegations(own, END);
    expect(got).toEqual([
      { id: expect.any(Number), title: 'Get the refund', status: 'waiting', nextStep: null, waitingOn: 'Dana', dueAt: '2026-10-12T20:00:00.000Z', followUpAt: null },
    ]);
  });
});
