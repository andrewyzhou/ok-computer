import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createLogTail, logFile } from './logs.js';
import { toDecision, toToolCall } from './queries.js';
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

describe('the trace kinds of the stream feed', () => {
  type Db = ReturnType<typeof openDb>;
  const run = (db: Db) =>
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'completed', 't0')").run();
  const modelCall = (db: Db, createdAt = 't1') =>
    Number(
      db
        .prepare(
          `INSERT INTO model_calls (runId, slot, provider, model, inputTokens, outputTokens, costUsd, latencyMs, stopReason, request, response, createdAt)
           VALUES ('r1', 'main', 'fake', 'm', 1000, 50, 0.01, 1200, 'end_turn', '{"secret":"request"}', '{"secret":"response"}', ?) RETURNING id`,
        )
        .get(createdAt)!.id,
    );
  const approval = (db: Db) =>
    Number(
      db
        .prepare(
          `INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt)
           VALUES ('r1', 'browser_submit', '{"secret":"input"}', 'browser_submit buy', 'pending', 't3') RETURNING id`,
        )
        .get()!.id,
    );
  const decision = (db: Db, verdict: string, approvalId: number | null) =>
    Number(
      db
        .prepare(
          `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, approvalId, createdAt)
           VALUES ('r1', 'tc1', 'browser_submit', ?, 'rule-1', 'seeded', ?, 't4') RETURNING id`,
        )
        .get(verdict, approvalId)!.id,
    );
  const toolCall = (db: Db, policyDecisionId: number | null) =>
    Number(
      db
        .prepare(
          `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel, source, policyDecisionId)
           VALUES ('r1', 'tc1', 'browser_submit', '{"secret":"input"}', '{"secret":"output"}', 0, 300, 't5', 'write', 'builtin', ?) RETURNING id`,
        )
        .get(policyDecisionId)!.id,
    );
  const step = (db: Db) => {
    db.prepare(
      `INSERT INTO browser_tasks (id, kind, sessionKey, runId, allowlist, status, startedAt) VALUES ('bt1', 'task', 'main', 'r1', '[]', 'open', 't0')`,
    ).run();
    return Number(
      db
        .prepare(
          `INSERT INTO browser_steps (taskId, runId, toolCallId, action, target, urlBefore, urlAfter, screenshotBlob, durationMs, createdAt)
           VALUES ('bt1', 'r1', 'tc1', 'open', '"https://rail.example/"', 'about:blank', 'https://rail.example/', 'blob-1', 400, 't6') RETURNING id`,
        )
        .get()!.id,
    );
  };

  it('sends one message of each kind with its summary fields only, in table order', () => {
    const db = openDb(':memory:');
    const poll = createFeed(db, () => []);
    run(db);
    expect(poll().map((message) => message.kind)).toEqual(['run']);

    const modelId = modelCall(db);
    const approvalId = approval(db);
    const decisionId = decision(db, 'ask', approvalId);
    const toolId = toolCall(db, decisionId);
    const stepId = step(db);
    expect(poll()).toEqual([
      {
        kind: 'model_call',
        call: { id: modelId, runId: 'r1', slot: 'main', model: 'm', costUsd: 0.01, latencyMs: 1200, error: null, createdAt: 't1' },
      },
      {
        kind: 'tool_call',
        call: { id: toolId, runId: 'r1', toolCallId: 'tc1', name: 'browser_submit', outcome: 'waiting', durationMs: 300, createdAt: 't5' },
      },
      {
        kind: 'policy',
        decision: {
          id: decisionId,
          runId: 'r1',
          toolCallId: 'tc1',
          toolName: 'browser_submit',
          decision: 'ask',
          rule: 'rule-1',
          reviewerVerdict: null,
          approvalId,
          createdAt: 't4',
        },
      },
      {
        kind: 'approval',
        approval: {
          id: approvalId,
          runId: 'r1',
          sessionKey: 'main',
          toolName: 'browser_submit',
          summary: 'browser_submit buy',
          status: 'pending',
          requestedAt: 't3',
          resolvedAt: null,
        },
      },
      {
        kind: 'browser_step',
        step: { id: stepId, taskId: 'bt1', runId: 'r1', action: 'open', urlAfter: 'https://rail.example/', screenshotBlob: 'blob-1', error: null, createdAt: 't6' },
      },
    ]);
    expect(poll()).toEqual([]);
  });

  it('sends a review decision again when its verdict or its approval comes, until its run ends', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 't0')").run();
    const poll = createFeed(db, () => []);
    poll();
    const policies = () => poll().flatMap((message) => (message.kind === 'policy' ? [message.decision] : []));
    const reviewId = decision(db, 'review', null);
    const allowId = decision(db, 'allow', null);
    expect(policies().map((each) => [each.id, each.reviewerVerdict, each.approvalId])).toEqual([
      [reviewId, null, null],
      [allowId, null, null],
    ]);
    expect(policies()).toEqual([]);

    db.prepare("UPDATE policy_decisions SET reviewerVerdict = 'ask' WHERE id = ?").run(reviewId);
    expect(policies()).toMatchObject([{ id: reviewId, decision: 'review', reviewerVerdict: 'ask', approvalId: null }]);
    expect(policies()).toEqual([]);

    const approvalId = approval(db);
    db.prepare('UPDATE policy_decisions SET approvalId = ? WHERE id = ?').run(approvalId, reviewId);
    expect(policies()).toMatchObject([{ id: reviewId, reviewerVerdict: 'ask', approvalId }]);

    // after the run ends, the decision is read one last time and then no more.
    db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'r1'").run();
    expect(policies()).toEqual([]);
    db.prepare("UPDATE policy_decisions SET reviewerVerdict = 'hold' WHERE id = ?").run(reviewId);
    expect(policies()).toEqual([]);
  });

  it('watches the review decisions of a run that was running when the feed was made', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 't0')").run();
    const reviewId = decision(db, 'review', null);
    const poll = createFeed(db, () => []);
    expect(poll()).toEqual([]);
    db.prepare("UPDATE policy_decisions SET reviewerVerdict = 'allow' WHERE id = ?").run(reviewId);
    expect(poll()).toMatchObject([{ kind: 'policy', decision: { id: reviewId, reviewerVerdict: 'allow' } }]);
  });

  it('sends a pending approval again when it is resolved, and one time when it is resolved between polls', () => {
    const db = openDb(':memory:');
    run(db);
    const poll = createFeed(db, () => []);
    const id = approval(db);
    expect(poll()).toMatchObject([{ kind: 'approval', approval: { id, status: 'pending', resolvedAt: null } }]);
    expect(poll()).toEqual([]);

    db.prepare("UPDATE approvals SET status = 'approved', resolvedAt = 't9', resolvedBy = 'owner' WHERE id = ?").run(id);
    expect(poll()).toEqual([
      {
        kind: 'approval',
        approval: {
          id,
          runId: 'r1',
          sessionKey: 'main',
          toolName: 'browser_submit',
          summary: 'browser_submit buy',
          status: 'approved',
          requestedAt: 't3',
          resolvedAt: 't9',
        },
      },
    ]);
    expect(poll()).toEqual([]);

    const quick = approval(db);
    db.prepare("UPDATE approvals SET status = 'denied', resolvedAt = 't10' WHERE id = ?").run(quick);
    expect(poll()).toMatchObject([{ kind: 'approval', approval: { id: quick, status: 'denied', resolvedAt: 't10' } }]);
    expect(poll()).toEqual([]);
  });

  it('does not send the rows that existed when the feed was made, but follows an approval that was pending then', () => {
    const db = openDb(':memory:');
    run(db);
    modelCall(db);
    const id = approval(db);
    toolCall(db, decision(db, 'allow', null));
    step(db);
    const poll = createFeed(db, () => []);
    expect(poll()).toEqual([]);

    db.prepare("UPDATE approvals SET status = 'expired', resolvedAt = 't9' WHERE id = ?").run(id);
    expect(poll()).toMatchObject([{ kind: 'approval', approval: { id, status: 'expired', resolvedAt: 't9' } }]);
    expect(poll()).toEqual([]);
  });

  it('reads at most 500 rows of a table on each poll and drains a burst without loss', () => {
    const db = openDb(':memory:');
    run(db);
    const poll = createFeed(db, () => []);
    const ids = Array.from({ length: 501 }, () => modelCall(db));
    const first = poll();
    const second = poll();
    expect(first).toHaveLength(500);
    expect(second).toHaveLength(1);
    expect([...first, ...second].map((message) => (message.kind === 'model_call' ? message.call.id : null))).toEqual(ids);
    expect(poll()).toEqual([]);
  });

  it('gives a tool call the outcome that toToolCall gives from its policy decision', () => {
    const db = openDb(':memory:');
    run(db);
    const poll = createFeed(db, () => []);
    const decisionId = decision(db, 'deny', null);
    const toolId = toolCall(db, decisionId);
    const row = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(toolId)!;
    const decisions = new Map([[decisionId, toDecision(db.prepare('SELECT *, NULL AS approvalStatus FROM policy_decisions WHERE id = ?').get(decisionId)!)]]);
    const expected = toToolCall(row, decisions).outcome;
    expect(expected).toBe('denied');
    const calls = poll().flatMap((message) => (message.kind === 'tool_call' ? [message.call] : []));
    expect(calls.map((call) => call.outcome)).toEqual([expected]);
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
