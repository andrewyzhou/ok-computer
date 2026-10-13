import { describe, expect, it } from 'vitest';
import { getApproval } from '../approvals/store.js';
import { openDb } from '../db/index.js';
import { appendEvent, listEvents } from '../events/log.js';
import { closeStaleWork, interruptedText, repairSession } from './recovery.js';

const clock = () => new Date('2026-10-13T03:15:00Z');

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  const turn = (...ids: string[]) =>
    appendEvent(db, {
      sessionKey: 'main',
      runId: 'r1',
      type: 'assistant_message',
      payload: { provider: 'fake', model: 'm', content: [], text: '', toolCalls: ids.map((id) => ({ id, name: `tool_${id}`, input: { id } })), stopReason: 'tool_use' },
    });
  const decide = (toolCallId: string, decision: string, extra: { reviewerVerdict?: string; approvalId?: number } = {}) =>
    db
      .prepare(
        `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerVerdict, approvalId, createdAt)
         VALUES ('r1', ?, ?, ?, 'test', 'test', ?, ?, 'x')`,
      )
      .run(toolCallId, `tool_${toolCallId}`, decision, extra.reviewerVerdict ?? null, extra.approvalId ?? null);
  const results = () => listEvents(db, 'main').flatMap((event) => (event.type === 'tool_result' ? [event.payload] : []));
  return { db, turn, decide, results };
}

describe('repairSession', () => {
  it('does nothing when every call has a result', () => {
    const { db, turn } = setup();
    turn('a');
    appendEvent(db, { sessionKey: 'main', runId: 'r1', type: 'tool_result', payload: { toolCallId: 'a', name: 'tool_a', content: 'ok', isError: false } });
    expect(repairSession(db, 'main', clock)).toBe(0);
  });

  it('gives each dangling call the result that fits what the trace shows, one time', () => {
    const { db, turn, decide, results } = setup();
    db.prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES ('r1', 'tool_d', '{}', 'd', 'pending', 'x')").run();
    turn('a', 'b', 'c', 'd', 'e', 'f');
    // a finished and was recorded, but the process stopped before its event. its untrusted source must stay.
    db.prepare(
      `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, untrustedSource)
       VALUES ('r1', 'a', 'tool_a', '{}', '{"content":"the real output"}', 0, 5, 'x', 'gmail:personal')`,
    ).run();
    decide('b', 'allow');
    decide('c', 'review', { reviewerVerdict: 'allow' });
    decide('d', 'approve', { approvalId: 1 });
    decide('e', 'review');
    // f has no decision: the process stopped before the policy check.
    expect(repairSession(db, 'main', clock)).toBe(6);
    expect(results()).toEqual([
      { toolCallId: 'a', name: 'tool_a', content: 'the real output', isError: false, untrustedSource: 'gmail:personal' },
      { toolCallId: 'b', name: 'tool_b', content: interruptedText('tool_b'), isError: true },
      { toolCallId: 'c', name: 'tool_c', content: interruptedText('tool_c'), isError: true },
      { toolCallId: 'd', name: 'tool_d', content: expect.stringContaining("waits for the owner's approval #1"), isError: false },
      { toolCallId: 'e', name: 'tool_e', content: 'tool_e did not run, because the app stopped first.', isError: true },
      { toolCallId: 'f', name: 'tool_f', content: 'tool_f did not run, because the app stopped first.', isError: true },
    ]);
    expect(db.prepare("SELECT toolCallId, outcome, policyDecisionId IS NOT NULL AS decided FROM tool_calls WHERE toolCallId != 'a' ORDER BY toolCallId").all()).toEqual([
      { toolCallId: 'b', outcome: 'interrupted', decided: 1 },
      { toolCallId: 'c', outcome: 'interrupted', decided: 1 },
      { toolCallId: 'd', outcome: null, decided: 1 },
      { toolCallId: 'e', outcome: null, decided: 1 },
      { toolCallId: 'f', outcome: null, decided: 0 },
    ]);
    expect(repairSession(db, 'main', clock)).toBe(0);
  });

  it('ignores calls before the last reset', () => {
    const { db, turn } = setup();
    turn('old');
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} });
    expect(repairSession(db, 'main', clock)).toBe(0);
  });
});

describe('closeStaleWork', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const hour = 60 * 60_000;
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('closes only the work that is older than the stale age', () => {
    const db = openDb(':memory:');
    const run = (id: string, startedAt: string) =>
      db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'running', ?)").run(id, startedAt);
    run('old', ago(2 * hour));
    // a live run of another process, for example the service while the owner uses npm run chat.
    run('live', ago(60_000));
    const approval = (resolvedAt: string, startedAt: string | null) =>
      db
        .prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt, resolvedAt, startedAt) VALUES ('old', 'send', '{\"to\":\"x\"}', 'send x', 'approved', 'x', ?, ?)")
        .run(resolvedAt, startedAt);
    approval(ago(2 * hour), null);
    approval(ago(60_000), null);
    approval(ago(2 * hour), ago(2 * hour));
    approval(ago(2 * hour), ago(2 * hour));
    // the fourth approval finished before the stop.
    db.prepare("INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt) VALUES ('old', 'approval-4', 'send', '{}', '{}', 0, 1, 'x')").run();

    const stale = closeStaleWork(db, now, hour);
    expect(stale.runs).toEqual([{ id: 'old', sessionKey: 'main' }]);
    expect(stale.expired.map((each) => each.id)).toEqual([1]);
    expect(stale.interrupted.map((each) => each.id)).toEqual([3]);
    expect(db.prepare('SELECT id, status FROM runs ORDER BY id').all()).toEqual([
      { id: 'live', status: 'running' },
      { id: 'old', status: 'aborted' },
    ]);
    expect([1, 2, 3, 4].map((id) => getApproval(db, id)!.status)).toEqual(['expired', 'approved', 'approved', 'approved']);
    expect(db.prepare("SELECT outcome, isError FROM tool_calls WHERE toolCallId = 'approval-3'").get()).toEqual({ outcome: 'interrupted', isError: 1 });

    // a second sweep finds nothing new.
    expect(closeStaleWork(db, now, hour)).toEqual({ runs: [], expired: [], interrupted: [] });
  });
});
