import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../src/db/index.js';

const real = join(import.meta.dirname, '..', 'src', 'db', 'migrations');
const sqlFiles = () => readdirSync(real).filter((file) => /^\d+_.+\.sql$/.test(file));

// a folder with the real migration files that the filter keeps.
function migrationsWith(keep: (file: string) => boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'okc-migrations-'));
  for (const file of sqlFiles().filter(keep)) writeFileSync(join(dir, file), readFileSync(join(real, file), 'utf8'));
  return dir;
}

const open: Db[] = [];
function track(db: Db): Db {
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const insertChange = (db: Db, values: { domain?: string; fromLevel: string; toLevel: string; actor: string; via: string }) =>
  db
    .prepare('INSERT INTO autonomy_changes (domain, fromLevel, toLevel, actor, via, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(values.domain ?? 'mail_drafts', values.fromLevel, values.toLevel, values.actor, values.via, '2026-10-20T09:00:00Z');

describe('migration 024', () => {
  it('refuses an update and a delete of the history', () => {
    const db = track(openDb(':memory:'));
    insertChange(db, { fromLevel: 'review', toLevel: 'auto', actor: 'owner', via: 'dashboard' });
    insertChange(db, { fromLevel: 'auto', toLevel: 'ask', actor: 'agent', via: 'chat' });
    expect(() => db.exec(`UPDATE autonomy_changes SET toLevel = 'auto' WHERE id = 2`)).toThrow('autonomy changes are append-only');
    expect(() => db.exec(`UPDATE autonomy_changes SET note = 'x'`)).toThrow('autonomy changes are append-only');
    expect(() => db.exec('DELETE FROM autonomy_changes WHERE id = 1')).toThrow('autonomy changes are append-only');
    expect(() => db.exec('DELETE FROM autonomy_changes')).toThrow('autonomy changes are append-only');
    // a replace is a delete and an insert, and sqlite runs the delete trigger for it only with recursive triggers on.
    // the insert trigger refuses it in both modes.
    const replace = `INSERT OR REPLACE INTO autonomy_changes (id, domain, fromLevel, toLevel, actor, via, createdAt) VALUES (1, 'mail_drafts', 'ask', 'ask', 'owner', 'dashboard', 'x')`;
    expect(() => db.exec(replace)).toThrow('autonomy changes are append-only');
    expect(() => db.exec(`REPLACE INTO autonomy_changes (id, domain, fromLevel, toLevel, actor, via, createdAt) VALUES (2, 'mail_drafts', 'ask', 'ask', 'owner', 'dashboard', 'x')`)).toThrow(
      'autonomy changes are append-only',
    );
    db.exec('PRAGMA recursive_triggers = ON');
    expect(() => db.exec(replace)).toThrow('autonomy changes are append-only');
    // a new row with its own id still goes in.
    insertChange(db, { fromLevel: 'ask', toLevel: 'review', actor: 'owner', via: 'dashboard' });
    expect(db.prepare('SELECT id, fromLevel, toLevel, createdAt FROM autonomy_changes ORDER BY id').all()).toEqual([
      { id: 1, fromLevel: 'review', toLevel: 'auto', createdAt: '2026-10-20T09:00:00Z' },
      { id: 2, fromLevel: 'auto', toLevel: 'ask', createdAt: '2026-10-20T09:00:00Z' },
      { id: 3, fromLevel: 'ask', toLevel: 'review', createdAt: '2026-10-20T09:00:00Z' },
    ]);
  });

  it('refuses a raise by the agent in a direct insert', () => {
    const db = track(openDb(':memory:'));
    for (const [fromLevel, toLevel] of [
      ['ask', 'review'],
      ['ask', 'auto'],
      ['review', 'auto'],
      // a change to the same level is no lowering either.
      ['review', 'review'],
    ] as const) {
      expect(() => insertChange(db, { fromLevel, toLevel, actor: 'agent', via: 'chat' })).toThrow(/CHECK constraint failed/);
    }
    // the agent can lower a level from chat.
    insertChange(db, { fromLevel: 'auto', toLevel: 'review', actor: 'agent', via: 'chat' });
    insertChange(db, { fromLevel: 'auto', toLevel: 'ask', actor: 'agent', via: 'chat' });
    insertChange(db, { fromLevel: 'review', toLevel: 'ask', actor: 'agent', via: 'chat' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM autonomy_changes').get()!.n).toBe(3);
  });

  it('refuses the agent on the dashboard, also for a lowering', () => {
    const db = track(openDb(':memory:'));
    expect(() => insertChange(db, { fromLevel: 'auto', toLevel: 'ask', actor: 'agent', via: 'dashboard' })).toThrow(/CHECK constraint failed/);
    expect(() => insertChange(db, { fromLevel: 'ask', toLevel: 'auto', actor: 'agent', via: 'dashboard' })).toThrow(/CHECK constraint failed/);
    expect(() => insertChange(db, { fromLevel: 'ask', toLevel: 'auto', actor: 'someone', via: 'chat' })).toThrow(/CHECK constraint failed/);
    expect(() => insertChange(db, { fromLevel: 'ask', toLevel: 'always', actor: 'owner', via: 'dashboard' })).toThrow(/CHECK constraint failed/);
    expect(() => insertChange(db, { fromLevel: 'ask', toLevel: 'auto', actor: 'owner', via: 'mail' })).toThrow(/CHECK constraint failed/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM autonomy_changes').get()!.n).toBe(0);
  });

  it('keeps a level pointed at a real history row', () => {
    const db = track(openDb(':memory:'));
    expect(() => db.exec(`INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES ('mail_drafts', 'auto', 99, 'x')`)).toThrow(/FOREIGN KEY/);
    insertChange(db, { fromLevel: 'review', toLevel: 'auto', actor: 'owner', via: 'dashboard' });
    expect(() => db.exec(`INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES ('mail_drafts', 'always', 1, 'x')`)).toThrow(/CHECK constraint failed/);
    db.exec(`INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES ('mail_drafts', 'auto', 1, 'x')`);
    expect(() => db.exec(`INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES ('mail_drafts', 'ask', 1, 'x')`)).toThrow(/UNIQUE/);
  });

  it('upgrades a database from before 024 and keeps its policy decisions', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'okc-autonomy-')), 'okc.sqlite');
    const before = migrationsWith((file) => file < '024');
    const db = track(openDb(path, before));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'autonomy_changes'`).all()).toEqual([]);
    db.exec(`
      INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'completed', 'x');
      INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, approvalId, createdAt)
        VALUES ('r', 'c1', 'google__gmail_draft', 'review', 'risk:write', 'writes a draft', NULL, '2026-10-01T00:00:00Z');
    `);
    const old = db.prepare('SELECT * FROM policy_decisions').get()!;

    expect(migrate(db, real)).toEqual(['024_autonomy.sql']);

    const row = db.prepare('SELECT * FROM policy_decisions').get()!;
    expect(row).toEqual({ ...old, autonomyDomain: null, autonomyLevel: null });
    expect(row).toMatchObject({ runId: 'r', toolCallId: 'c1', toolName: 'google__gmail_draft', decision: 'review', rule: 'risk:write', reason: 'writes a draft' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM autonomy_changes').get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM autonomy_levels').get()!.n).toBe(0);
    // a new decision can name its domain and level.
    db.exec(`
      INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, approvalId, createdAt, autonomyDomain, autonomyLevel)
        VALUES ('r', 'c2', 'google__gmail_draft', 'review', 'risk:write', 'writes a draft', NULL, 'x', 'mail_drafts', 'review');
    `);
    expect(db.prepare(`SELECT autonomyDomain, autonomyLevel FROM policy_decisions WHERE toolCallId = 'c2'`).get()).toEqual({ autonomyDomain: 'mail_drafts', autonomyLevel: 'review' });
    // a second open applies nothing new.
    expect(migrate(db, real)).toEqual([]);
  });

  it('does not depend on the migrations 021 to 023 of the other tracks', () => {
    // 024 sorts after 021 to 023, so it also runs on a database that has them. it must apply as well on one that
    // does not, because the tracks merge in any order.
    const without = migrationsWith((file) => file < '021' || file.startsWith('024_'));
    const db = track(openDb(':memory:', without));
    const applied = db.prepare('SELECT name FROM migrations ORDER BY name').all().map((row) => String(row.name));
    expect(applied.at(-1)).toBe('024_autonomy.sql');
    expect(applied.some((name) => /^02[123]_/.test(name))).toBe(false);
    const sql = readFileSync(join(real, '024_autonomy.sql'), 'utf8');
    for (const table of ['delegation', 'doc_versions', 'docs', 'people', 'person']) expect(sql).not.toMatch(new RegExp(`\\b${table}\\b`));
  });
});
