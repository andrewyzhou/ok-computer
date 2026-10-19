import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLogsFor } from './logs.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-10-13T12:00:00Z');

const line = (ts: string, msg: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts, level: 'info', msg, ...extra });

// the local day 2026-10-12 in los angeles runs from 07:00z on 10-12 to 07:00z on 10-13, over two utc files.
function logDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'okc-logs-'));
  writeFileSync(
    join(dir, 'okc-2026-10-12.log'),
    [
      line('2026-10-12T06:59:59.999Z', 'the day before'),
      line('2026-10-12T07:00:00.000Z', 'start of the day', { runId: 'run-a' }),
      'not json at all',
      JSON.stringify({ ts: '2026-10-12T15:00:00.000Z', level: 'warn', msg: 'a warning', runId: 'run-b' }),
      JSON.stringify({ ts: '2026-10-12T20:00:00.000Z', level: 'error', msg: 'an error', runId: 'run-a' }),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(dir, 'okc-2026-10-13.log'),
    [
      line('2026-10-13T01:00:00.000Z', 'the evening', { runId: 'run-a' }),
      line('2026-10-13T06:59:59.999Z', 'end of the day'),
      line('2026-10-13T07:00:00.000Z', 'the day after'),
      'broken today',
    ].join('\n') + '\n',
  );
  return dir;
}

describe('readLogsFor', () => {
  it('reads a local day over two utc files and drops the lines outside it', () => {
    const lines = readLogsFor(logDir(), NOW, TZ, { level: 'debug', limit: 5000, day: '2026-10-12' });
    expect(lines.map((l) => l.msg)).toEqual(['start of the day', 'a warning', 'an error', 'the evening', 'end of the day']);
  });

  it('applies the level, the run id and the limit after the day', () => {
    const dir = logDir();
    expect(readLogsFor(dir, NOW, TZ, { level: 'warn', limit: 5000, day: '2026-10-12' }).map((l) => l.msg)).toEqual(['a warning', 'an error']);
    expect(readLogsFor(dir, NOW, TZ, { level: 'debug', limit: 5000, day: '2026-10-12', runId: 'run-a' }).map((l) => l.msg)).toEqual([
      'start of the day',
      'an error',
      'the evening',
    ]);
    expect(readLogsFor(dir, NOW, TZ, { level: 'debug', limit: 2, day: '2026-10-12', runId: 'run-a' }).map((l) => l.msg)).toEqual([
      'an error',
      'the evening',
    ]);
  });

  it('reads the utc file of today without a day, and keeps a line that does not parse there', () => {
    const dir = logDir();
    expect(readLogsFor(dir, NOW, TZ, { level: 'debug', limit: 5000 }).map((l) => l.msg)).toEqual([
      'the evening',
      'end of the day',
      'the day after',
      'broken today',
    ]);
    expect(readLogsFor(dir, NOW, TZ, { level: 'debug', limit: 5000, runId: 'run-a' }).map((l) => l.msg)).toEqual(['the evening']);
  });

  it('gives nothing for a day without files', () => {
    expect(readLogsFor(logDir(), NOW, TZ, { level: 'debug', limit: 5000, day: '2026-09-01' })).toEqual([]);
  });

  it('reads the one file of a day when the other is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-logs-'));
    writeFileSync(join(dir, 'okc-2026-10-13.log'), line('2026-10-13T01:00:00.000Z', 'only one file') + '\n');
    expect(readLogsFor(dir, NOW, TZ, { level: 'debug', limit: 5000, day: '2026-10-12' }).map((l) => l.msg)).toEqual(['only one file']);
  });
});
