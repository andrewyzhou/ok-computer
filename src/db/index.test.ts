import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('migration 006', () => {
  it('upgrades a database at 005 with real rows', () => {
    const real = join(import.meta.dirname, 'migrations');
    const files = readdirSync(real).filter((file) => file.endsWith('.sql'));
    const upTo005 = migrationsDir(Object.fromEntries(files.filter((file) => file < '006').map((file) => [file, readFileSync(join(real, file), 'utf8')])));
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, upTo005);
    const blob = 'a'.repeat(64);
    db.exec(`
      INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'completed', 'x');
      INSERT INTO events (sessionKey, runId, seq, type, payload, createdAt) VALUES ('main', 'r', 1, 'note', '{"text":"a"}', 'x');
      INSERT INTO blobs (hash, size, mime, createdAt, refCount) VALUES ('${blob}', 5, 'text/plain', 'x', 2);
      INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt, resolvedAt) VALUES
        ('r', 'send', '{}', 's', 'approved', 'x', '2026-10-01T00:00:00Z'),
        ('r', 'send', '{}', 's', 'pending', 'x', NULL),
        ('r', 'send', '{}', 's', 'denied', 'x', '2026-10-01T00:00:00Z');
      INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, approvalId, createdAt)
        VALUES ('r', 'c1', 'memory_get', 'allow', 'risk:read', 'reads', NULL, 'x');
      INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, policyDecisionId,
          rawResultBlob, modelViewBlob, truncated, resultHandle, costUsd)
        VALUES ('r', 'c1', 'memory_get', '{}', '{"content":"x"}', 0, 1, 'x', 1, '${blob}', '${'b'.repeat(64)}', 1, 'res_0123456789ab', 0.5);
      INSERT INTO mcp_messages (serverId, direction, method, payload, createdAt) VALUES ('fs', 'out', 'tools/list', '{}', 'x');
      INSERT INTO subagent_runs (parentRunId, childRunId, profile, task, createdAt) VALUES ('r', 'r', 'p', 't', 'x');
    `);

    expect(migrate(db, real)).toEqual(['006_trace_contract.sql']);
    const columns = (table: string) => db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name);
    expect(columns('tool_calls')).not.toContain('modelViewBlob');
    expect(columns('tool_calls')).not.toContain('costUsd');
    expect(columns('tool_calls')).toContain('outcome');
    expect(columns('blobs')).not.toContain('refCount');
    expect(columns('policy_decisions')).toContain('taint');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    for (const dropped of ['browser_steps', 'sandbox_execs', 'integration_events', 'subagent_runs']) expect(tables).not.toContain(dropped);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_messages').get()).toEqual({ n: 1 });

    expect(db.prepare('SELECT toolCallId, rawResultBlob, resultHandle, outcome, policyDecisionId FROM tool_calls').all()).toEqual([
      { toolCallId: 'c1', rawResultBlob: blob, resultHandle: 'res_0123456789ab', outcome: null, policyDecisionId: 1 },
    ]);
    expect(db.prepare('SELECT hash, size FROM blobs').all()).toEqual([{ hash: blob, size: 5 }]);
    // an approved call ran right after its decision before 006, so it counts as started.
    expect(db.prepare('SELECT status, startedAt FROM approvals ORDER BY id').all()).toEqual([
      { status: 'approved', startedAt: '2026-10-01T00:00:00Z' },
      { status: 'pending', startedAt: null },
      { status: 'denied', startedAt: null },
    ]);
    expect(db.prepare('SELECT taint FROM policy_decisions').get()).toEqual({ taint: null });
    // a handle stays unique.
    expect(() =>
      db.exec(`INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, resultHandle)
        VALUES ('r', 'c2', 'memory_get', '{}', '{}', 0, 1, 'x', 'res_0123456789ab')`),
    ).toThrow(/UNIQUE/);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(['tool_calls_run_call', 'events_reset', 'events_taint', 'tool_calls_handle']));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

describe('openDb', () => {
  it('creates the schema and uses wal mode for a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-db-'));
    const db = openDb(join(dir, 'nested', 'okc.sqlite'));
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['events', 'runs', 'model_calls', 'tool_calls', 'migrations', 'blobs', 'policy_decisions']),
    );
    db.close();
  });
});
