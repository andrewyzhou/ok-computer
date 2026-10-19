import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { appendEvent } from '../events/log.js';
import { migrate } from './index.js';

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'okc-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

const real = join(import.meta.dirname, 'migrations');

function databaseAt017(): DatabaseSync {
  const files = readdirSync(real).filter((file) => file.endsWith('.sql') && file < '018');
  const dir = migrationsDir(Object.fromEntries(files.map((file) => [file, readFileSync(join(real, file), 'utf8')])));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, dir);
  return db;
}

describe('migration 018', () => {
  it('indexes the readable events of a database at 017 and keeps the log append-only', () => {
    const db = databaseAt017();
    db.exec(`
      INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'completed', 't0');
      INSERT INTO events (sessionKey, runId, seq, type, payload, createdAt) VALUES
        ('main', 'r', 1, 'context', '{"text":"the system prompt"}', 't1'),
        ('main', 'r', 2, 'user_message', '{"text":"plan the trip","channel":"web","chatId":"web"}', 't2'),
        ('main', 'r', 3, 'assistant_message', '{"text":"","toolCalls":[]}', 't3'),
        ('main', 'r', 4, 'tool_result', '{"toolCallId":"c1","name":"now","content":"it is noon","isError":false}', 't4'),
        ('main', 'r', 5, 'assistant_message', '{"text":"the ferry leaves at 11","toolCalls":[]}', 't5'),
        ('main', NULL, 6, 'system_event', '{"text":"a check-in"}', 't6'),
        ('main', NULL, 7, 'note', '{"text":"a note"}', 't7'),
        ('main', NULL, 8, 'compaction', '{"summary":"the old part","firstKeptEventId":2,"tokensBefore":1,"tokensAfter":1,"model":"m","clearToolResults":false}', 't8'),
        ('main', NULL, 9, 'session_reset', '{}', 't9'),
        ('heartbeat:1', NULL, 1, 'note', '{"text":"a heartbeat note"}', 't10');
    `);
    const ids = new Map(db.prepare('SELECT seq, sessionKey, id FROM events').all().map((row) => [`${row.sessionKey}:${row.seq}`, Number(row.id)]));

    expect(migrate(db, real)).toContain('018_search.sql');

    const indexed = db.prepare('SELECT rowid, text, sessionKey, runId, type, eventId, createdAt FROM events_fts ORDER BY rowid').all();
    const expected = [
      ['main:2', 'plan the trip', 'r', 'user_message', 't2'],
      ['main:4', 'it is noon', 'r', 'tool_result', 't4'],
      ['main:5', 'the ferry leaves at 11', 'r', 'assistant_message', 't5'],
      ['main:6', 'a check-in', null, 'system_event', 't6'],
      ['main:7', 'a note', null, 'note', 't7'],
      ['main:8', 'the old part', null, 'compaction', 't8'],
      ['heartbeat:1:1', 'a heartbeat note', null, 'note', 't10'],
    ] as const;
    expect(indexed).toEqual(
      expected.map(([key, text, runId, type, createdAt]) => ({
        rowid: ids.get(key),
        text,
        sessionKey: key.startsWith('heartbeat') ? 'heartbeat:1' : 'main',
        runId,
        type,
        eventId: ids.get(key),
        createdAt,
      })),
    );
    expect(db.prepare('SELECT rowid, COUNT(*) AS n FROM events_fts GROUP BY rowid HAVING n > 1').all()).toEqual([]);

    // the trigger indexes each new event with the same rule.
    const added = appendEvent(db, { sessionKey: 'main', runId: 'r', type: 'user_message', payload: { text: 'a new coast message', channel: 'web', chatId: 'web' } });
    appendEvent(db, { sessionKey: 'main', runId: 'r', type: 'context', payload: { text: 'the coast prompt' } });
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} });
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'note', payload: { text: '' } });
    expect(db.prepare('SELECT rowid, eventId, type FROM events_fts WHERE events_fts MATCH ?').all('"coast"')).toEqual([
      { rowid: added.id, eventId: added.id, type: 'user_message' },
    ]);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM events_fts').get()!.n)).toBe(expected.length + 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events_fts WHERE type IN ('context', 'session_reset')").get()).toEqual({ n: 0 });

    // the event log stays append-only.
    expect(() => db.prepare("UPDATE events SET payload = '{}' WHERE id = ?").run(added.id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(added.id)).toThrow(/append-only/);

    const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name IN ('events_run', 'runs_started') ORDER BY name").all();
    expect(indexes).toEqual([
      { name: 'events_run', tbl_name: 'events' },
      { name: 'runs_started', tbl_name: 'runs' },
    ]);
    // a second migrate has nothing to do.
    expect(migrate(db, real)).toEqual([]);
  });
});
