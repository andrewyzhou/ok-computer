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

  it('names the integration tool of a tool_call, and keeps the arguments that the decision saw', () => {
    const { db, results } = setup();
    appendEvent(db, {
      sessionKey: 'main',
      runId: 'r1',
      type: 'assistant_message',
      payload: {
        provider: 'fake',
        model: 'm',
        content: [],
        text: '',
        toolCalls: [{ id: 'm1', name: 'tool_call', input: { name: 'notes__add_note', arguments: { note: 'buy milk' } } }],
        stopReason: 'tool_use',
      },
    });
    db.prepare(
      `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, createdAt) VALUES ('r1', 'm1', 'notes__add_note', 'allow', 'test', 'test', 'x')`,
    ).run();
    repairSession(db, 'main', clock);
    // the event keeps the model's own name, so the provider pairs it with the call.
    expect(results()).toEqual([{ toolCallId: 'm1', name: 'tool_call', content: interruptedText('notes__add_note'), isError: true }]);
    // the row counts for the integration, so its page shows the call whose effect is unknown.
    expect(db.prepare("SELECT name, input, outcome, source, serverId FROM tool_calls WHERE toolCallId = 'm1'").get()).toEqual({
      name: 'notes__add_note',
      input: '{"note":"buy milk"}',
      outcome: 'interrupted',
      source: 'mcp',
      serverId: 'notes',
    });
  });

  // a call without input could not be bound, and the repair threw at each run start, so the session was blocked.
  it('repairs each call on its own, so one odd call does not block the session', () => {
    const { db, decide, results } = setup();
    appendEvent(db, {
      sessionKey: 'main',
      runId: 'r1',
      type: 'assistant_message',
      payload: {
        provider: 'fake',
        model: 'm',
        content: [],
        text: '',
        toolCalls: [
          { id: 'bare', name: 'tool_bare', input: undefined },
          { id: 'damaged', name: 'tool_damaged', input: {} },
          { id: 'ok', name: 'tool_ok', input: {} },
        ],
        stopReason: 'tool_use',
      },
    });
    decide('bare', 'allow');
    db.prepare("INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt) VALUES ('r1', 'damaged', 'tool_damaged', '{}', 'not json', 0, 1, 'x')").run();
    expect(repairSession(db, 'main', clock)).toBe(3);
    expect(results().map((each) => [each.toolCallId, each.content])).toEqual([
      ['bare', interruptedText('tool_bare')],
      ['damaged', interruptedText('tool_damaged')],
      ['ok', 'tool_ok did not run, because the app stopped first.'],
    ]);
    expect(db.prepare("SELECT input, outcome FROM tool_calls WHERE toolCallId = 'bare'").get()).toEqual({ input: 'null', outcome: 'interrupted' });
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

  it('counts an interrupted approved call of an integration tool for its integration', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
    db.prepare(
      "INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt, resolvedAt, startedAt) VALUES ('r1', 'notes__add_note', '{}', 'add', 'approved', 'x', ?, ?)",
    ).run(ago(2 * hour), ago(2 * hour));
    expect(closeStaleWork(db, now, hour).interrupted).toHaveLength(1);
    expect(db.prepare("SELECT outcome, source, serverId FROM tool_calls WHERE toolCallId = 'approval-1'").get()).toEqual({
      outcome: 'interrupted',
      source: 'mcp',
      serverId: 'notes',
    });
  });

  // an attempt that the integration did not send gives the approval back, and its row stays. a later approval that the
  // process loses while it runs must still be found.
  it('reports an interrupted approved call that has a row of an earlier attempt that did not send it', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
    db.prepare(
      "INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt, resolvedAt, startedAt) VALUES ('r1', 'notes__add_note', '{}', 'add', 'approved', 'x', ?, ?)",
    ).run(ago(2 * hour), ago(2 * hour));
    db.prepare(
      "INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt) VALUES ('r1', 'approval-1', 'notes__add_note', '{}', '{}', 1, 0, ?)",
    ).run(ago(3 * hour));
    expect(closeStaleWork(db, now, hour).interrupted.map((each) => each.id)).toEqual([1]);
    expect(db.prepare("SELECT outcome FROM tool_calls WHERE toolCallId = 'approval-1' ORDER BY id").all()).toEqual([{ outcome: null }, { outcome: 'interrupted' }]);
  });

  // the service and npm run chat can sweep at the same moment. here the second sweep runs between the select of the
  // first sweep and its inserts. each call must get one row, one note and one message to the owner.
  it('reports an interrupted approved call one time when two processes sweep at the same moment', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 'x')").run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt, resolvedAt, startedAt) VALUES ('r1', 'send', '{}', 'send', 'approved', 'x', ?, ?)",
      ).run(ago(2 * hour), ago(2 * hour));
    }
    let other: ReturnType<typeof closeStaleWork> | undefined;
    const first = new Proxy(db, {
      get: (target, key) =>
        key === 'prepare'
          ? (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('AND NOT EXISTS (SELECT 1 FROM tool_calls WHERE tool_calls.runId')) return statement;
              return { all: (...args: never[]) => [statement.all(...args), (other = closeStaleWork(db, now, hour))][0] };
            }
          : Reflect.get(target, key, target),
    }) as typeof db;
    const mine = closeStaleWork(first, now, hour);
    expect(other!.interrupted.map((each) => each.id)).toEqual([1, 2, 3]);
    expect(mine.interrupted).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE outcome = 'interrupted'").get()).toEqual({ n: 3 });
  });
});
