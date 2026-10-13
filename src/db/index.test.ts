import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './index.js';

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'okc-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('migrate', () => {
  it('applies files in numeric order and only one time', () => {
    const dir = migrationsDir({
      '002_b.sql': 'INSERT INTO t (v) VALUES (2);',
      '001_a.sql': 'CREATE TABLE t (v INTEGER);',
    });
    const db = new DatabaseSync(':memory:');
    expect(migrate(db, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect(migrate(db, dir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(1);
  });

  it('rolls back a failed migration', () => {
    const dir = migrationsDir({
      '001_a.sql': 'CREATE TABLE t (v INTEGER);',
      '002_bad.sql': 'CREATE TABLE u (v INTEGER); THIS IS NOT SQL;',
    });
    const db = new DatabaseSync(':memory:');
    expect(() => migrate(db, dir)).toThrow(/002_bad.sql/);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toContain('t');
    expect(tables).not.toContain('u');
  });
});

describe('openDb', () => {
  it('creates the schema and uses wal mode for a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-db-'));
    const db = openDb(join(dir, 'nested', 'okc.sqlite'));
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['events', 'runs', 'model_calls', 'tool_calls', 'migrations']));
    db.close();
  });
});
