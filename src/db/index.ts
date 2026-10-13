import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export function openDb(path: string, migrationsDir = MIGRATIONS_DIR): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, migrationsDir);
  return db;
}

// each migration file runs in its own transaction. a failed file leaves the database at the previous version.
export function migrate(db: Db, dir: string): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((row) => String(row.name)),
  );
  const files = readdirSync(dir)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name, appliedAt) VALUES (?, ?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
    newlyApplied.push(file);
  }
  return newlyApplied;
}
