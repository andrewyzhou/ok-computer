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

// each migration file runs in its own savepoint. a failed file leaves the database at the previous version. the files
// share one transaction, so a new database flushes to disk once and not once for each file: on windows each flush can
// take hundreds of milliseconds on a busy disk, and a new database with 20 files took up to 5 s to open.
export function migrate(db: Db, dir: string): string[] {
  const files = readdirSync(dir)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();
  const newlyApplied: string[] = [];
  let failed: Error | undefined;
  // the write lock is taken at the start, so a second process that opens the database at the same time waits for the
  // busy timeout instead of failing in the middle.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
    const applied = new Set(
      db.prepare('SELECT name FROM migrations').all().map((row) => String(row.name)),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(`${dir}/${file}`, 'utf8');
      db.exec('SAVEPOINT migration');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO migrations (name, appliedAt) VALUES (?, ?)').run(file, new Date().toISOString());
        db.exec('RELEASE migration');
      } catch (err) {
        failed = new Error(`migration ${file} failed: ${(err as Error).message}`);
        // some errors, for example a full disk, end the whole transaction, and the savepoint is gone with it.
        if (db.isTransaction) {
          db.exec('ROLLBACK TO migration');
          db.exec('RELEASE migration');
        }
        break;
      }
      newlyApplied.push(file);
    }
    if (db.isTransaction) db.exec('COMMIT');
  } catch (err) {
    // an error outside a file, or one that ended the transaction, keeps the database as it was.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  if (failed) throw failed;
  return newlyApplied;
}
