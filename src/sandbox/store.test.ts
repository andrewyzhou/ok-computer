import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { DEFAULT_LIMITS } from './limits.js';
import { addFiles, closeStale, finishExec, STALE_ERROR, startExec } from './store.js';
import type { ExecEnd, NewExec } from './types.js';

const at = (iso: string) => new Date(iso);

const exec = (over: Partial<NewExec> = {}): NewExec => ({
  runId: 'run-1',
  toolCallId: 'c1',
  sessionKey: 'main',
  taskId: 'task-1',
  language: 'python',
  command: 'print(1)',
  image: 'okc-sandbox:1',
  cwd: '/work',
  network: 'none',
  allowlist: [],
  limits: DEFAULT_LIMITS,
  ...over,
});

const end = (over: Partial<ExecEnd> = {}): ExecEnd => ({
  status: 'ok',
  exitCode: 0,
  imageId: 'sha256:abc',
  containerId: 'c0ffee',
  stdoutBlob: 'a'.repeat(64),
  stderrBlob: null,
  stdoutBytes: 2,
  stderrBytes: 0,
  truncated: false,
  error: null,
  durationMs: 1234.6,
  ...over,
});

describe('sandbox store', () => {
  it('starts a running row and finishes it', () => {
    const db = openDb(':memory:');
    const id = startExec(db, exec({ network: 'allowlist', allowlist: ['pypi.org'] }), at('2026-10-18T10:00:00Z'));
    expect(db.prepare('SELECT * FROM sandbox_execs WHERE id = ?').get(id)).toMatchObject({
      runId: 'run-1',
      toolCallId: 'c1',
      sessionKey: 'main',
      taskId: 'task-1',
      language: 'python',
      command: 'print(1)',
      cwd: '/work',
      network: 'allowlist',
      allowlist: '["pypi.org"]',
      limits: JSON.stringify(DEFAULT_LIMITS),
      status: 'running',
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: 0,
      durationMs: 0,
      createdAt: '2026-10-18T10:00:00.000Z',
      endedAt: null,
    });

    finishExec(db, id, end(), at('2026-10-18T10:00:02Z'));
    expect(db.prepare('SELECT * FROM sandbox_execs WHERE id = ?').get(id)).toMatchObject({
      status: 'ok',
      exitCode: 0,
      imageId: 'sha256:abc',
      containerId: 'c0ffee',
      stdoutBlob: 'a'.repeat(64),
      stderrBlob: null,
      stdoutBytes: 2,
      truncated: 0,
      durationMs: 1235,
      endedAt: '2026-10-18T10:00:02.000Z',
    });
  });

  it('changes only a running row, so the first end sticks', () => {
    const db = openDb(':memory:');
    const id = startExec(db, exec(), at('2026-10-18T10:00:00Z'));
    finishExec(db, id, end({ status: 'timeout', exitCode: null, error: 'too slow' }), at('2026-10-18T10:01:00Z'));
    finishExec(db, id, end(), at('2026-10-18T10:02:00Z'));
    expect(db.prepare('SELECT status, error, endedAt FROM sandbox_execs WHERE id = ?').get(id)).toEqual({
      status: 'timeout',
      error: 'too slow',
      endedAt: '2026-10-18T10:01:00.000Z',
    });
  });

  it('closes the old running rows that do not run in this process', () => {
    const db = openDb(':memory:');
    const old = startExec(db, exec(), at('2026-10-18T09:00:00Z'));
    const live = startExec(db, exec(), at('2026-10-18T09:00:00Z'));
    const fresh = startExec(db, exec(), at('2026-10-18T09:59:00Z'));
    const done = startExec(db, exec(), at('2026-10-18T09:00:00Z'));
    finishExec(db, done, end(), at('2026-10-18T09:00:01Z'));

    const now = at('2026-10-18T10:00:00Z');
    expect(closeStale(db, now, 5 * 60_000, new Set([live]))).toEqual([old]);
    const rows = db.prepare('SELECT id, status, error, endedAt FROM sandbox_execs ORDER BY id').all();
    expect(rows).toEqual([
      { id: old, status: 'error', error: STALE_ERROR, endedAt: '2026-10-18T10:00:00.000Z' },
      { id: live, status: 'running', error: null, endedAt: null },
      { id: fresh, status: 'running', error: null, endedAt: null },
      { id: done, status: 'ok', error: null, endedAt: '2026-10-18T09:00:01.000Z' },
    ]);
    // a late finish of the closed row does not change it.
    finishExec(db, old, end(), at('2026-10-18T10:00:05Z'));
    expect(db.prepare('SELECT status FROM sandbox_execs WHERE id = ?').get(old)).toEqual({ status: 'error' });
    // a second sweep finds nothing new.
    expect(closeStale(db, now, 5 * 60_000, new Set([live]))).toEqual([]);
  });

  it('adds the files of an exec', () => {
    const db = openDb(':memory:');
    const id = startExec(db, exec(), at('2026-10-18T10:00:00Z'));
    addFiles(db, id, [], at('2026-10-18T10:00:00Z'));
    addFiles(
      db,
      id,
      [
        { direction: 'in', path: 'data/in.csv', blob: 'b'.repeat(64), size: 10, mime: 'text/csv' },
        { direction: 'out', path: 'out.png', blob: 'c'.repeat(64), size: 99, mime: 'image/png' },
      ],
      at('2026-10-18T10:00:01Z'),
    );
    expect(db.prepare('SELECT execId, direction, path, blob, size, mime, createdAt FROM sandbox_files ORDER BY id').all()).toEqual([
      { execId: id, direction: 'in', path: 'data/in.csv', blob: 'b'.repeat(64), size: 10, mime: 'text/csv', createdAt: '2026-10-18T10:00:01.000Z' },
      { execId: id, direction: 'out', path: 'out.png', blob: 'c'.repeat(64), size: 99, mime: 'image/png', createdAt: '2026-10-18T10:00:01.000Z' },
    ]);
  });
});
