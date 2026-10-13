import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createLogTail, logFile } from './logs.js';
import { createFeed } from './stream.js';

describe('the stream feed', () => {
  it('sends new events, new runs and each status change one time', () => {
    const db = openDb(':memory:');
    const note = (text: string) => appendEvent(db, { sessionKey: 'main', runId: null, type: 'note', payload: { text } });
    note('old');
    const poll = createFeed(db, () => []);
    expect(poll()).toEqual([]);

    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
    note('new');
    expect(poll().map((message) => (message.kind === 'run' ? message.run.status : message.kind))).toEqual(['running', 'event']);
    expect(poll()).toEqual([]);

    db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'r1'").run();
    expect(poll()).toMatchObject([{ kind: 'run', run: { id: 'r1', status: 'completed' } }]);
    expect(poll()).toEqual([]);
  });
});

describe('the log tail', () => {
  it('gives only complete new lines and moves to the file of the next utc date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-logs-'));
    let now = new Date('2026-10-12T23:59:00Z');
    writeFileSync(logFile(dir, now), '{"ts":"a","level":"info","msg":"before"}\n');
    const tail = createLogTail(dir, () => now);
    expect(tail()).toEqual([]);

    appendFileSync(logFile(dir, now), '{"ts":"b","level":"warn","msg":"one"}\n{"ts":"c","level":"info","msg":"tw');
    expect(tail().map((line) => line.msg)).toEqual(['one']);
    appendFileSync(logFile(dir, now), 'o"}\n');
    expect(tail().map((line) => line.msg)).toEqual(['two']);

    now = new Date('2026-10-13T00:00:30Z');
    expect(tail()).toEqual([]);
    writeFileSync(logFile(dir, now), '{"ts":"d","level":"error","msg":"next day"}\n');
    expect(tail().map((line) => line.msg)).toEqual(['next day']);
  });
});
