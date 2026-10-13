import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { sessionTaint } from './store.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
  return db;
}

const now = new Date('2026-10-13T16:00:00Z');

describe('sessionTaint', () => {
  it('names the integration tool of a tool_call result from its trace row', () => {
    const db = setup();
    db.prepare(
      `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt)
       VALUES ('r1', 'c1', 'mail__read_inbox', '{}', '{}', 0, 1, 'x')`,
    ).run();
    const result = (toolCallId: string) =>
      appendEvent(
        db,
        { sessionKey: 'main', runId: 'r1', type: 'tool_result', payload: { toolCallId, name: 'tool_call', content: 'x', isError: false, untrustedSource: `mcp:${toolCallId}` } },
        now,
      );
    result('c1');
    // a result without a row keeps the name of the event.
    result('c2');
    expect(sessionTaint(db, 'main').map((each) => each.toolName)).toEqual(['mail__read_inbox', 'tool_call']);
  });

  // the check runs before every tool call. the name lookup runs one time for each source, so it adds little to a long
  // session with 50 untrusted results. the query itself grows with the number of such results: 1.5 ms for 500.
  it('stays under 1 ms on a session with 50,000 events', () => {
    const db = setup();
    const event = db.prepare("INSERT INTO events (sessionKey, runId, seq, type, payload, createdAt) VALUES ('main', 'r1', ?, ?, ?, 'x')");
    const row = db.prepare(
      "INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt) VALUES ('r1', ?, 'mail__read_inbox', '{}', '{}', 0, 1, 'x')",
    );
    db.exec('BEGIN');
    for (let seq = 1; seq <= 50_000; seq++) {
      const tainted = seq % 1000 === 0;
      if (tainted) row.run(`c${seq}`);
      const payload = tainted
        ? { toolCallId: `c${seq}`, name: 'tool_call', content: 'x', isError: false, untrustedSource: `mcp:mail${seq % 3}` }
        : { toolCallId: `c${seq}`, name: 'now', content: 'x', isError: false };
      event.run(seq, 'tool_result', JSON.stringify(payload));
    }
    db.exec('COMMIT');
    expect(sessionTaint(db, 'main')).toHaveLength(3);
    const started = performance.now();
    for (let i = 0; i < 20; i++) sessionTaint(db, 'main');
    expect((performance.now() - started) / 20).toBeLessThan(1);
  });
});
