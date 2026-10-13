import type { Db } from './index.js';

export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? (JSON.parse(String(row.value)) as T) : undefined;
}

export function setSetting(db: Db, key: string, value: unknown, now: Date): void {
  db.prepare(
    `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  ).run(key, JSON.stringify(value), now.toISOString());
}
