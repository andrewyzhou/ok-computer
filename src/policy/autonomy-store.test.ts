import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutonomyDomain, AutonomyLevel } from '../dashboard/autonomy-types.js';
import { openDb, type Db } from '../db/index.js';
import { DOMAIN_IDS, DOMAINS } from './autonomy.js';
import { AutonomyError, changeLevel, HISTORY_LIMIT, levelOf, listChanges, NOTE_LIMIT, storedLevels, type LevelChange } from './autonomy-store.js';

const NOW = new Date('2026-10-20T09:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const open: Db[] = [];
function memoryDb(): Db {
  const db = openDb(':memory:');
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const count = (db: Db, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

const owner = (domain: AutonomyDomain, level: AutonomyLevel, extra: Partial<LevelChange> = {}): LevelChange => ({
  domain,
  level,
  actor: 'owner',
  via: 'dashboard',
  ...extra,
});

const agent = (domain: AutonomyDomain, level: AutonomyLevel, extra: Partial<LevelChange> = {}): LevelChange => ({
  domain,
  level,
  actor: 'agent',
  via: 'chat',
  runId: 'run-1',
  toolCallId: 'call-1',
  sessionKey: 'main',
  ...extra,
});

// the code of the AutonomyError that the call throws, so a test can check the reason and not only the throw.
function codeOf(call: () => unknown): string {
  try {
    call();
  } catch (err) {
    expect(err).toBeInstanceOf(AutonomyError);
    return (err as AutonomyError).code;
  }
  throw new Error('the call did not throw');
}

describe('levelOf', () => {
  it('gives the default level of each domain while no row exists', () => {
    const db = memoryDb();
    for (const spec of DOMAINS) expect(levelOf(db, spec.id)).toBe(spec.defaultLevel);
  });

  it('gives the stored level after a change', () => {
    const db = memoryDb();
    changeLevel(db, owner('mail_drafts', 'auto'), NOW);
    expect(levelOf(db, 'mail_drafts')).toBe('auto');
  });

  it('clamps a hand-edited level above the most of its domain', () => {
    const db = memoryDb();
    // the table check allows auto, so a hand edit can put a fixed domain at auto. the store must still read ask.
    const change = db
      .prepare(`INSERT INTO autonomy_changes (domain, fromLevel, toLevel, actor, via, createdAt) VALUES ('purchases', 'ask', 'auto', 'owner', 'dashboard', 'x') RETURNING id`)
      .get()!;
    db.prepare(`INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES ('purchases', 'auto', ?, 'x')`).run(Number(change.id));
    db.prepare(`INSERT INTO autonomy_changes (domain, fromLevel, toLevel, actor, via, createdAt) VALUES ('sandbox_network', 'ask', 'auto', 'owner', 'dashboard', 'x')`).run();
    db.prepare(`INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES ('sandbox_network', 'auto', last_insert_rowid(), 'x')`).run();

    expect(levelOf(db, 'purchases')).toBe('ask');
    expect(levelOf(db, 'sandbox_network')).toBe('review');
    expect(storedLevels(db).purchases.level).toBe('ask');
    expect(storedLevels(db).sandbox_network.level).toBe('review');
    // a change to ask on the clamped fixed domain is no change, and a raise stays refused.
    expect(changeLevel(db, owner('purchases', 'ask'), NOW)).toBeNull();
    expect(codeOf(() => changeLevel(db, owner('purchases', 'auto'), NOW))).toBe('fixed');
  });

  it('throws unknown_domain for a domain that is not in the list', () => {
    const db = memoryDb();
    expect(codeOf(() => levelOf(db, 'wire_transfers' as AutonomyDomain))).toBe('unknown_domain');
    expect(codeOf(() => changeLevel(db, owner('wire_transfers' as AutonomyDomain, 'ask'), NOW))).toBe('unknown_domain');
  });
});

describe('storedLevels', () => {
  it('gives an entry for each of the 8 domains, with null times at the defaults', () => {
    const db = memoryDb();
    const levels = storedLevels(db);
    expect(Object.keys(levels).sort()).toEqual([...DOMAIN_IDS].sort());
    expect(DOMAIN_IDS).toHaveLength(8);
    for (const spec of DOMAINS) expect(levels[spec.id]).toEqual({ level: spec.defaultLevel, updatedAt: null, changeId: null });
  });

  it('gives the time and the history row of the last change', () => {
    const db = memoryDb();
    const row = changeLevel(db, owner('calendar_holds', 'auto'), NOW)!;
    const levels = storedLevels(db);
    expect(levels.calendar_holds).toEqual({ level: 'auto', updatedAt: NOW.toISOString(), changeId: row.id });
    expect(levels.mail_drafts).toEqual({ level: 'review', updatedAt: null, changeId: null });
  });
});

describe('changeLevel', () => {
  it('(a) refuses a raise that does not come from the owner on the dashboard, and writes nothing', () => {
    const db = memoryDb();
    changeLevel(db, owner('mail_labels', 'ask'), NOW);
    const before = [count(db, 'autonomy_changes'), count(db, 'autonomy_levels')];

    expect(codeOf(() => changeLevel(db, agent('mail_labels', 'review'), NOW))).toBe('not_lower');
    expect(codeOf(() => changeLevel(db, agent('mail_labels', 'auto'), NOW))).toBe('not_lower');
    expect(codeOf(() => changeLevel(db, agent('mail_drafts', 'auto'), NOW))).toBe('not_lower');
    expect(codeOf(() => changeLevel(db, { ...owner('mail_labels', 'auto'), via: 'chat' }, NOW))).toBe('not_lower');
    expect(codeOf(() => changeLevel(db, { ...agent('mail_labels', 'auto'), via: 'dashboard' }, NOW))).toBe('not_lower');

    expect([count(db, 'autonomy_changes'), count(db, 'autonomy_levels')]).toEqual(before);
    expect(levelOf(db, 'mail_labels')).toBe('ask');
    expect(db.isTransaction).toBe(false);

    // the owner on the dashboard can raise it.
    expect(changeLevel(db, owner('mail_labels', 'auto'), NOW)?.toLevel).toBe('auto');
  });

  it('(b) lets the agent lower a level from chat', () => {
    const db = memoryDb();
    changeLevel(db, owner('mail_drafts', 'auto'), NOW);
    expect(changeLevel(db, agent('mail_drafts', 'review'), at(1))).toMatchObject({ fromLevel: 'auto', toLevel: 'review', actor: 'agent', via: 'chat' });
    expect(changeLevel(db, agent('mail_drafts', 'ask'), at(2))).toMatchObject({ fromLevel: 'review', toLevel: 'ask' });

    changeLevel(db, owner('calendar_holds', 'auto'), NOW);
    const row = changeLevel(db, agent('calendar_holds', 'ask'), at(3))!;
    expect(row).toMatchObject({ fromLevel: 'auto', toLevel: 'ask', runId: 'run-1', toolCallId: 'call-1', sessionKey: 'main', createdAt: at(3).toISOString() });
    expect(levelOf(db, 'mail_drafts')).toBe('ask');
    expect(levelOf(db, 'calendar_holds')).toBe('ask');
  });

  it('(c) keeps the fixed domains at ask, also for the owner', () => {
    const db = memoryDb();
    for (const domain of ['calendar_guests', 'unsubscribes', 'purchases'] as const) {
      for (const level of ['review', 'auto'] as const) {
        expect(codeOf(() => changeLevel(db, owner(domain, level), NOW))).toBe('fixed');
        expect(codeOf(() => changeLevel(db, agent(domain, level), NOW))).toBe('fixed');
      }
      expect(changeLevel(db, owner(domain, 'ask'), NOW)).toBeNull();
      expect(changeLevel(db, agent(domain, 'ask'), NOW)).toBeNull();
      expect(levelOf(db, domain)).toBe('ask');
    }
    expect(count(db, 'autonomy_changes')).toBe(0);
    expect(count(db, 'autonomy_levels')).toBe(0);
  });

  it('(d) refuses a level above the most of its domain', () => {
    const db = memoryDb();
    expect(codeOf(() => changeLevel(db, owner('browser_submits', 'auto'), NOW))).toBe('above_max');
    expect(codeOf(() => changeLevel(db, owner('sandbox_network', 'auto'), NOW))).toBe('above_max');
    expect(count(db, 'autonomy_changes')).toBe(0);
    // review is the most of both, and the owner can choose it.
    expect(changeLevel(db, owner('browser_submits', 'review'), NOW)?.toLevel).toBe('review');
    expect(changeLevel(db, owner('sandbox_network', 'review'), NOW)?.toLevel).toBe('review');
  });

  it('(e) refuses a change with a stale expected level, and writes nothing', () => {
    const db = memoryDb();
    expect(codeOf(() => changeLevel(db, owner('mail_drafts', 'auto', { expected: 'ask' }), NOW))).toBe('stale');
    expect(count(db, 'autonomy_changes')).toBe(0);
    expect(count(db, 'autonomy_levels')).toBe(0);

    changeLevel(db, owner('mail_drafts', 'auto', { expected: 'review' }), NOW);
    const before = count(db, 'autonomy_changes');
    // a stale expected level refuses also a change to the current level.
    expect(codeOf(() => changeLevel(db, owner('mail_drafts', 'auto', { expected: 'review' }), NOW))).toBe('stale');
    expect(codeOf(() => changeLevel(db, agent('mail_drafts', 'ask', { expected: 'review' }), NOW))).toBe('stale');
    expect(count(db, 'autonomy_changes')).toBe(before);
    expect(levelOf(db, 'mail_drafts')).toBe('auto');
    expect(db.isTransaction).toBe(false);
  });

  it('(f) gives null for the same level and writes no history row', () => {
    const db = memoryDb();
    expect(changeLevel(db, owner('mail_drafts', 'review'), NOW)).toBeNull();
    expect(changeLevel(db, agent('browser_submits', 'ask', { expected: 'ask' }), NOW)).toBeNull();
    expect(count(db, 'autonomy_changes')).toBe(0);
    expect(count(db, 'autonomy_levels')).toBe(0);

    changeLevel(db, owner('mail_drafts', 'auto'), NOW);
    expect(changeLevel(db, owner('mail_drafts', 'auto'), at(5))).toBeNull();
    expect(count(db, 'autonomy_changes')).toBe(1);
    expect(storedLevels(db).mail_drafts.updatedAt).toBe(NOW.toISOString());
  });

  it('(g) writes one history row from the previous level and points the level at it', () => {
    const db = memoryDb();
    const first = changeLevel(db, owner('mail_labels', 'auto', { note: 'trusted now' }), NOW)!;
    expect(first).toEqual({
      id: first.id,
      domain: 'mail_labels',
      fromLevel: 'review',
      toLevel: 'auto',
      actor: 'owner',
      via: 'dashboard',
      runId: null,
      toolCallId: null,
      sessionKey: null,
      note: 'trusted now',
      createdAt: NOW.toISOString(),
    });
    expect(count(db, 'autonomy_changes')).toBe(1);
    expect(db.prepare('SELECT * FROM autonomy_levels').all()).toEqual([{ domain: 'mail_labels', level: 'auto', changeId: first.id, updatedAt: NOW.toISOString() }]);

    const second = changeLevel(db, agent('mail_labels', 'review'), at(1))!;
    expect(second.fromLevel).toBe('auto');
    expect(count(db, 'autonomy_changes')).toBe(2);
    expect(db.prepare('SELECT * FROM autonomy_levels').all()).toEqual([{ domain: 'mail_labels', level: 'review', changeId: second.id, updatedAt: at(1).toISOString() }]);
    expect(listChanges(db, { limit: 10 })).toEqual([second, first]);
  });

  it('(h) redacts the note and cuts it to the note limit', () => {
    const db = memoryDb();
    const key = `sk-ant-${'a1B2c3D4e5'.repeat(4)}`;
    const row = changeLevel(db, owner('mail_drafts', 'auto', { note: `the key is ${key} ${'x'.repeat(NOTE_LIMIT * 2)}` }), NOW)!;
    expect(row.note).not.toContain(key);
    expect(row.note).toContain('[redacted]');
    expect(row.note!.length).toBe(NOTE_LIMIT);
    const stored = db.prepare('SELECT note FROM autonomy_changes WHERE id = ?').get(row.id)!;
    expect(stored.note).toBe(row.note);
    // an empty note is stored as no note.
    expect(changeLevel(db, owner('mail_drafts', 'review', { note: '' }), NOW)!.note).toBeNull();
  });

  it('(i) throws bad_level for a level that is not ask, review or auto', () => {
    const db = memoryDb();
    expect(codeOf(() => changeLevel(db, owner('mail_drafts', 'always' as AutonomyLevel), NOW))).toBe('bad_level');
    expect(codeOf(() => changeLevel(db, owner('mail_drafts', 'auto', { expected: 'AUTO' as AutonomyLevel }), NOW))).toBe('bad_level');
    expect(codeOf(() => changeLevel(db, owner('purchases', '' as AutonomyLevel), NOW))).toBe('bad_level');
    expect(count(db, 'autonomy_changes')).toBe(0);
  });

  it('(j) uses the transaction of the caller and does not commit it', () => {
    const db = memoryDb();
    db.exec('BEGIN');
    const row = changeLevel(db, owner('mail_drafts', 'auto'), NOW)!;
    expect(db.isTransaction).toBe(true);
    expect(levelOf(db, 'mail_drafts')).toBe('auto');
    // a refused change inside the transaction leaves the transaction of the caller open.
    expect(codeOf(() => changeLevel(db, agent('mail_drafts', 'auto', { expected: 'ask' }), NOW))).toBe('stale');
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(levelOf(db, 'mail_drafts')).toBe('review');
    expect(db.prepare('SELECT COUNT(*) AS n FROM autonomy_changes WHERE id = ?').get(row.id)!.n).toBe(0);

    db.exec('BEGIN');
    changeLevel(db, owner('mail_drafts', 'auto'), NOW);
    db.exec('COMMIT');
    expect(levelOf(db, 'mail_drafts')).toBe('auto');
  });

  it('takes back a half-written change in either kind of transaction', () => {
    const db = memoryDb();
    // a trigger makes the upsert of the level fail after the history row is written.
    db.exec(`CREATE TEMP TRIGGER break_levels BEFORE INSERT ON autonomy_levels BEGIN SELECT RAISE(ABORT, 'broken'); END`);
    expect(() => changeLevel(db, owner('mail_drafts', 'auto'), NOW)).toThrow(/broken/);
    expect(db.isTransaction).toBe(false);
    expect(count(db, 'autonomy_changes')).toBe(0);

    db.exec('BEGIN');
    db.exec(`INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'running', 'x')`);
    expect(() => changeLevel(db, owner('mail_drafts', 'auto'), NOW)).toThrow(/broken/);
    expect(db.isTransaction).toBe(true);
    expect(count(db, 'autonomy_changes')).toBe(0);
    db.exec('COMMIT');
    // the work of the caller in its own transaction stays.
    expect(count(db, 'runs')).toBe(1);
    expect(count(db, 'autonomy_changes')).toBe(0);
  });

  it('refuses the second of two changes that saw the same level, across two connections', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'okc-autonomy-')), 'okc.sqlite');
    const dashboard = openDb(path);
    open.push(dashboard);
    const chat = openDb(path);
    open.push(chat);
    changeLevel(dashboard, owner('mail_drafts', 'auto'), NOW);

    const seenByDashboard = levelOf(dashboard, 'mail_drafts');
    const seenByChat = levelOf(chat, 'mail_drafts');
    expect([seenByDashboard, seenByChat]).toEqual(['auto', 'auto']);

    expect(changeLevel(chat, agent('mail_drafts', 'ask', { expected: seenByChat }), at(1))?.toLevel).toBe('ask');
    expect(codeOf(() => changeLevel(dashboard, owner('mail_drafts', 'review', { expected: seenByDashboard }), at(2)))).toBe('stale');

    expect(levelOf(dashboard, 'mail_drafts')).toBe('ask');
    expect(count(dashboard, 'autonomy_changes')).toBe(2);
    expect(dashboard.isTransaction).toBe(false);
    expect(chat.isTransaction).toBe(false);
  });

  it('keeps the history append-only and the level on its newest change over many changes', () => {
    const db = memoryDb();
    const ids: number[] = [];
    const cycle: AutonomyLevel[] = ['ask', 'auto', 'review'];
    for (let i = 0; i < 30; i++) {
      const row = changeLevel(db, owner('mail_drafts', cycle[i % 3]!), at(i))!;
      ids.push(row.id);
      expect(storedLevels(db).mail_drafts.changeId).toBe(row.id);
      const newest = db.prepare(`SELECT MAX(id) AS id FROM autonomy_changes WHERE domain = 'mail_drafts'`).get()!;
      expect(Number(newest.id)).toBe(row.id);
    }
    expect(count(db, 'autonomy_changes')).toBe(30);
    expect(count(db, 'autonomy_levels')).toBe(1);
    // each row stays as it was written, and each row starts where the one before it ended.
    const rows = listChanges(db, { domain: 'mail_drafts', limit: HISTORY_LIMIT }).reverse();
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows[0]!.fromLevel).toBe('review');
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.fromLevel).toBe(rows[i - 1]!.toLevel);
    expect(() => db.exec('DELETE FROM autonomy_changes')).toThrow(/append-only/);
    expect(() => db.exec(`UPDATE autonomy_changes SET note = 'x'`)).toThrow(/append-only/);
  });

  it('leaves the other domains alone', () => {
    const db = memoryDb();
    const before = storedLevels(db);
    const row = changeLevel(db, owner('calendar_holds', 'auto'), NOW)!;
    const after = storedLevels(db);
    for (const domain of DOMAIN_IDS) {
      if (domain === 'calendar_holds') expect(after[domain]).toEqual({ level: 'auto', updatedAt: NOW.toISOString(), changeId: row.id });
      else expect(after[domain]).toEqual(before[domain]);
    }
    changeLevel(db, owner('mail_drafts', 'ask'), at(1));
    expect(storedLevels(db).calendar_holds).toEqual(after.calendar_holds);
  });
});

describe('listChanges', () => {
  function seeded(): { db: Db; ids: number[] } {
    const db = memoryDb();
    const ids = [
      changeLevel(db, owner('mail_drafts', 'auto'), at(0))!.id,
      changeLevel(db, owner('mail_labels', 'auto'), at(1))!.id,
      changeLevel(db, agent('mail_drafts', 'ask'), at(2))!.id,
      changeLevel(db, owner('calendar_holds', 'ask'), at(3))!.id,
      changeLevel(db, agent('mail_labels', 'review'), at(4))!.id,
    ];
    return { db, ids };
  }

  it('gives the newest first', () => {
    const { db, ids } = seeded();
    expect(listChanges(db, { limit: 50 }).map((row) => row.id)).toEqual([...ids].reverse());
  });

  it('filters by domain', () => {
    const { db, ids } = seeded();
    const rows = listChanges(db, { domain: 'mail_drafts', limit: 50 });
    expect(rows.map((row) => row.id)).toEqual([ids[2], ids[0]]);
    expect(rows.every((row) => row.domain === 'mail_drafts')).toBe(true);
    expect(listChanges(db, { domain: 'purchases', limit: 50 })).toEqual([]);
  });

  it('gives only older rows with before', () => {
    const { db, ids } = seeded();
    expect(listChanges(db, { before: ids[3], limit: 50 }).map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(listChanges(db, { before: ids[3], domain: 'mail_labels', limit: 50 }).map((row) => row.id)).toEqual([ids[1]]);
    expect(listChanges(db, { before: ids[0], limit: 50 })).toEqual([]);
    // pages of two walk the whole history without a gap or a repeat.
    const walked: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = listChanges(db, { before, limit: 2 });
      if (!page.length) break;
      walked.push(...page.map((row) => row.id));
      before = page.at(-1)!.id;
    }
    expect(walked).toEqual([...ids].reverse());
  });

  it('clamps the limit to 1 to HISTORY_LIMIT', () => {
    const db = memoryDb();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) changeLevel(db, owner('mail_drafts', i % 2 ? 'review' : 'auto'), at(i));
    expect(HISTORY_LIMIT).toBe(200);
    expect(listChanges(db, { limit: 0 })).toHaveLength(1);
    expect(listChanges(db, { limit: -3 })).toHaveLength(1);
    expect(listChanges(db, { limit: Number.NaN })).toHaveLength(1);
    expect(listChanges(db, { limit: 2.7 })).toHaveLength(2);
    expect(listChanges(db, { limit: 10000 })).toHaveLength(200);
  });
});
