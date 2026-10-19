import { describe, expect, it } from 'vitest';
import { runSpans } from '../src/dashboard/spans.js';
import type { RunSpans, Span, SpanKind } from '../src/dashboard/types.js';
import { CHILD_RUN, seedM1, T0, TRACE_RUN } from './seed-m1.js';
import { seedDashboard } from './seed.js';

const KIND_ORDER: SpanKind[] = ['run', 'model', 'tool', 'subagent', 'review', 'approval', 'mcp', 'google', 'browser', 'sandbox'];

// the run span is first, each parent comes before the spans inside it, and the children of one parent are sorted by
// start, then by kind, then by id. a child whose start is before the start of its parent waits for its parent.
function expectSorted(spans: Span[]) {
  expect(spans[0]!.kind).toBe('run');
  const position = new Map(spans.map((span, index) => [span.id, index]));
  for (const span of spans.slice(1)) expect(position.get(span.parentId!)!, `${span.parentId} before ${span.id}`).toBeLessThan(position.get(span.id)!);
  const siblings = new Map<string, Span[]>();
  for (const span of spans.slice(1)) siblings.set(span.parentId!, [...(siblings.get(span.parentId!) ?? []), span]);
  for (const group of siblings.values()) {
    for (let i = 1; i < group.length; i++) {
      const [a, b] = [group[i - 1]!, group[i]!];
      const order = a.startMs - b.startMs || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.id < b.id ? -1 : 1);
      expect(order, `${a.id} before ${b.id}`).toBeLessThan(0);
    }
  }
}

function expectParents(spans: Span[]) {
  const ids = new Set(spans.map((span) => span.id));
  expect(ids.size).toBe(spans.length);
  for (const span of spans.slice(1)) expect(ids.has(span.parentId!), `${span.id} has parent ${span.parentId}`).toBe(true);
}

const byId = (result: RunSpans) => new Map(result.spans.map((span) => [span.id, span]));

describe('the spans of a run', () => {
  it('times each span of the traced run from the start of the run', async () => {
    const { dashboard, ids } = await seedM1();
    const response = await dashboard.request(`/api/runs/${TRACE_RUN}/spans`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as RunSpans;
    expect(result).toMatchObject({ runId: TRACE_RUN, startedAt: T0, durationMs: 20_000 });
    expect(result.costUsd).toBeCloseTo(0.033, 10);
    const spans = byId(result);
    const timing = (id: string) => {
      const span = spans.get(id);
      expect(span, id).toBeDefined();
      return [span!.startMs, span!.endMs];
    };
    const turnOne = `model:${ids.turnOne}`;

    expect(result.spans[0]!.id).toBe(`run:${TRACE_RUN}`);
    expect(timing(`run:${TRACE_RUN}`)).toEqual([0, 20_000]);
    expect(spans.get(`run:${TRACE_RUN}`)).toMatchObject({ parentId: null, status: 'completed', ref: { kind: 'run', runId: TRACE_RUN } });
    expect(spans.get(`run:${TRACE_RUN}`)!.costUsd).toBeCloseTo(0.031, 10);
    expect(spans.get(`run:${TRACE_RUN}`)).toMatchObject({ inputTokens: 3000, outputTokens: 150 });

    expect(timing(turnOne)).toEqual([0, 2_000]);
    expect(spans.get(turnOne)).toMatchObject({
      parentId: `run:${TRACE_RUN}`,
      label: 'm (main)',
      status: 'tool_use',
      costUsd: 0.01,
      inputTokens: 1000,
      outputTokens: 50,
      ref: { kind: 'model', modelCallId: ids.turnOne },
    });
    expect(timing(`model:${ids.turnTwo}`)).toEqual([15_000, 18_000]);
    expect(spans.get(`model:${ids.turnTwo}`)!.status).toBe('end_turn');

    expect(timing(`review:${ids.reviewCall}`)).toEqual([16_000, 17_500]);
    expect(spans.get(`review:${ids.reviewCall}`)).toMatchObject({
      parentId: `run:${TRACE_RUN}`,
      status: 'hold',
      ref: { kind: 'review', modelCallId: ids.reviewCall, toolCallId: 'reply' },
    });
    expect(spans.has(`model:${ids.reviewCall}`)).toBe(false);

    const tools: Array<[number, string, string, number, number]> = [
      [ids.gmailRow, 'gmail_search', 'tc-gmail', 2_500, 4_000],
      [ids.browserRow, 'browser_open', 'tc-browser', 2_000, 6_000],
      [ids.mcpRow, 'fs__read', 'tc-mcp', 3_000, 5_000],
      [ids.delegateRow, 'delegate', 'tc-sub', 3_000, 14_000],
    ];
    for (const [rowId, name, toolCallId, start, end] of tools) {
      expect(timing(`tool:${rowId}`)).toEqual([start, end]);
      expect(spans.get(`tool:${rowId}`)).toMatchObject({ parentId: turnOne, label: name, status: 'ok', ref: { kind: 'tool', toolCallRowId: rowId, toolCallId } });
    }
    expect([...spans.keys()].some((id) => id.startsWith('tool:pending:'))).toBe(false);

    expect(timing(`google:${ids.googleRequestId}`)).toEqual([2_500, 3_400]);
    expect(spans.get(`google:${ids.googleRequestId}`)).toMatchObject({
      parentId: `tool:${ids.gmailRow}`,
      status: '200',
      label: 'GET gmail.googleapis.com/gmail/v1/users/me/messages',
      ref: { kind: 'google', googleRequestId: ids.googleRequestId },
    });

    expect(timing(`mcp:${ids.mcpOut}`)).toEqual([3_200, 4_700]);
    expect(spans.get(`mcp:${ids.mcpOut}`)).toMatchObject({
      parentId: `tool:${ids.mcpRow}`,
      label: 'fs tools/call',
      status: 'ok',
      ref: { kind: 'mcp', mcpMessageId: ids.mcpOut },
    });
    expect(spans.has(`mcp:${ids.mcpIn}`)).toBe(false);

    expect(timing(`browser:${ids.openStep}`)).toEqual([2_200, 3_000]);
    expect(timing(`browser:${ids.snapshotStep}`)).toEqual([5_000, 5_500]);
    expect(spans.get(`browser:${ids.snapshotStep}`)).toMatchObject({
      parentId: `tool:${ids.browserRow}`,
      label: 'snapshot',
      status: 'ok',
      ref: { kind: 'browser', browserStepId: ids.snapshotStep, taskId: 'bt_live' },
    });

    expect(timing(`subagent:${CHILD_RUN}`)).toEqual([3_000, 13_000]);
    expect(spans.get(`subagent:${CHILD_RUN}`)).toMatchObject({
      parentId: `tool:${ids.delegateRow}`,
      label: 'sub-agent research',
      status: 'completed',
      costUsd: 0.002,
      ref: { kind: 'subagent', childRunId: CHILD_RUN },
    });
    expect(timing(`model:${ids.childCall}`)).toEqual([4_000, 12_000]);
    expect(spans.get(`model:${ids.childCall}`)!.parentId).toBe(`subagent:${CHILD_RUN}`);
    expect(spans.has(`run:${CHILD_RUN}`)).toBe(false);

    expect(timing(`approval:${ids.approvalId}`)).toEqual([16_000, null]);
    expect(spans.get(`approval:${ids.approvalId}`)).toMatchObject({
      parentId: `run:${TRACE_RUN}`,
      label: 'browser_submit',
      status: 'pending',
      endAt: null,
      ref: { kind: 'approval', approvalId: ids.approvalId },
    });

    expect(result.spans).toHaveLength(15);
    expectSorted(result.spans);
    expectParents(result.spans);
    // the spans that start at 3000 sort by kind: the tool calls before the sub-agent that one of them holds.
    expect(result.spans.filter((span) => span.startMs === 3_000).map((span) => span.kind)).toEqual(['tool', 'tool', 'subagent']);
  });

  it('gives the child run its own waterfall with the same rules', async () => {
    const { t, ids } = await seedM1();
    const result = runSpans(t.db, CHILD_RUN)!;
    expect(result.spans.map((span) => [span.id, span.startMs, span.endMs])).toEqual([
      [`run:${CHILD_RUN}`, 0, 10_000],
      [`model:${ids.childCall}`, 1_000, 9_000],
    ]);
    expect(result.costUsd).toBe(0.002);
  });

  it('leaves open ends null for a running run, a pending delegate call and requests with no answer', async () => {
    const { t } = await seedM1();
    const db = t.db;
    const origin = Date.parse('2026-10-12T20:00:00.000Z');
    const at = (ms: number) => new Date(origin + ms).toISOString();
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('open-1', 'main', 'message', 'main', 'running', ?)").run(at(0));
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('open-1-child', 'sub:x', 'subagent', 'main', 'running', ?)").run(at(1_500));
    const turn = Number(
      db
        .prepare(
          `INSERT INTO model_calls (runId, slot, provider, model, latencyMs, stopReason, request, response, createdAt)
           VALUES ('open-1', 'main', 'fake', 'm', 1000, 'tool_use', '{}', ?, ?) RETURNING id`,
        )
        .get(JSON.stringify({ toolCalls: [{ id: 'tc-d', name: 'delegate', input: {} }] }), at(1_000))!.id,
    );
    const failed = Number(
      db
        .prepare(
          `INSERT INTO model_calls (runId, slot, provider, model, latencyMs, error, request, createdAt)
           VALUES ('open-1', 'main', 'fake', 'm', 250, 'the request was too large', '{}', ?) RETURNING id`,
        )
        .get(at(4_000))!.id,
    );
    db.prepare("INSERT INTO subagent_runs (parentRunId, toolCallId, childRunId, profile, createdAt) VALUES ('open-1', 'tc-d', 'open-1-child', 'research', ?)").run(at(1_500));
    const mcp = (direction: string, rpcId: string | null, ms: number) =>
      Number(
        db
          .prepare(
            `INSERT INTO mcp_messages (serverId, runId, toolCallId, direction, method, rpcId, payload, createdAt)
             VALUES ('fs', 'open-1', 'tc-x', ?, 'tools/call', ?, '{}', ?) RETURNING id`,
          )
          .get(direction, rpcId, at(ms))!.id,
      );
    const unanswered = mcp('out', '1', 2_000);
    const notification = mcp('out', null, 2_100);
    const unsent = mcp('unsent', '2', 2_200);
    const google = (status: number | null, error: string | null, ms: number) =>
      Number(
        db
          .prepare(
            `INSERT INTO google_requests (account, runId, toolCallId, method, url, status, error, latencyMs, createdAt)
             VALUES ('personal', 'open-1', NULL, 'POST', 'https://www.googleapis.com/calendar/v3/events?x=1', ?, ?, NULL, ?) RETURNING id`,
          )
          .get(status, error, at(ms))!.id,
      );
    const inFlight = google(null, null, 2_500);
    const broken = google(null, 'socket hang up', 2_600);
    const answered = google(503, null, 2_700);

    const result = runSpans(db, 'open-1')!;
    expect(result).toMatchObject({ runId: 'open-1', endedAt: null, durationMs: null, costUsd: null });
    const spans = byId(result);
    expect(spans.get('run:open-1')).toMatchObject({ startMs: 0, endMs: null, endAt: null, status: 'running', costUsd: null });
    expect(spans.get(`model:${turn}`)).toMatchObject({ startMs: 0, endMs: 1_000 });
    expect(spans.get(`model:${failed}`)).toMatchObject({ startMs: 3_750, endMs: 4_000, status: 'error', error: 'the request was too large' });
    expect(spans.get('tool:pending:tc-d')).toMatchObject({
      parentId: `model:${turn}`,
      label: 'delegate',
      startMs: 1_500,
      endMs: null,
      status: 'running',
      ref: { kind: 'tool', toolCallId: 'tc-d' },
    });
    expect(spans.get('subagent:open-1-child')).toMatchObject({ parentId: 'tool:pending:tc-d', startMs: 1_500, endMs: null, status: 'running', costUsd: null });
    expect(spans.get(`mcp:${unanswered}`)).toMatchObject({ parentId: 'run:open-1', startMs: 2_000, endMs: null, endAt: null });
    expect(spans.has(`mcp:${notification}`)).toBe(false);
    expect(spans.get(`mcp:${unsent}`)).toMatchObject({ startMs: 2_200, endMs: 2_200, status: 'unsent' });
    expect(spans.get(`google:${inFlight}`)).toMatchObject({ startMs: 2_500, endMs: null, status: null, label: 'POST www.googleapis.com/calendar/v3/events' });
    expect(spans.get(`google:${broken}`)).toMatchObject({ startMs: 2_600, endMs: 2_600, status: 'error', error: 'socket hang up' });
    expect(spans.get(`google:${answered}`)).toMatchObject({ startMs: 2_700, endMs: 2_700, status: '503' });
    expectSorted(result.spans);
    expectParents(result.spans);
  });

  it('gives a run with no rows only its run span', async () => {
    const { t } = await seedM1();
    t.db
      .prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt, endedAt) VALUES ('empty-1', 'main', 'message', 'main', 'failed', ?, ?)")
      .run('2026-10-12T20:00:00.000Z', '2026-10-12T20:00:01.250Z');
    expect(runSpans(t.db, 'empty-1')).toEqual({
      runId: 'empty-1',
      startedAt: '2026-10-12T20:00:00.000Z',
      endedAt: '2026-10-12T20:00:01.250Z',
      durationMs: 1_250,
      costUsd: null,
      spans: [
        {
          id: 'run:empty-1',
          parentId: null,
          kind: 'run',
          label: 'message (main)',
          startAt: '2026-10-12T20:00:00.000Z',
          endAt: '2026-10-12T20:00:01.250Z',
          startMs: 0,
          endMs: 1_250,
          status: 'failed',
          error: null,
          costUsd: null,
          inputTokens: 0,
          outputTokens: 0,
          ref: { kind: 'run', runId: 'empty-1' },
        },
      ],
    });
  });

  it('walks a sub-agent link that points back into the walk only once', async () => {
    const { t } = await seedM1();
    const db = t.db;
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt, endedAt) VALUES ('loop-a', 'main', 'message', 'main', 'completed', ?, ?)").run(
      '2026-10-12T20:00:00.000Z',
      '2026-10-12T20:00:05.000Z',
    );
    db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt, endedAt) VALUES ('loop-b', 'sub:x', 'subagent', 'main', 'completed', ?, ?)").run(
      '2026-10-12T20:00:01.000Z',
      '2026-10-12T20:00:04.000Z',
    );
    db.prepare("INSERT INTO subagent_runs (parentRunId, toolCallId, childRunId, profile, createdAt) VALUES ('loop-a', 'tc-1', 'loop-b', 'research', ?)").run('2026-10-12T20:00:01.000Z');
    db.prepare("INSERT INTO subagent_runs (parentRunId, toolCallId, childRunId, profile, createdAt) VALUES ('loop-b', 'tc-2', 'loop-a', 'research', ?)").run('2026-10-12T20:00:02.000Z');
    const result = runSpans(db, 'loop-a')!;
    expectParents(result.spans);
    expect(result.spans.filter((span) => span.kind === 'subagent').map((span) => span.id)).toEqual(['subagent:loop-b', 'subagent:loop-a']);
  });

  it('reads the sandbox spans from the table of m9, and none when the table is gone', async () => {
    const { t } = await seedM1();
    const db = t.db;
    expect(runSpans(db, TRACE_RUN)!.spans.some((span) => span.kind === 'sandbox')).toBe(false);
    // 020_sandbox.sql makes the table. the row is written with status running before the container starts, and the end
    // sets endedAt and the status.
    const insert = db.prepare(
      `INSERT INTO sandbox_execs (runId, toolCallId, language, command, image, cwd, network, allowlist, limits, status, exitCode, error, durationMs, createdAt, endedAt)
       VALUES (?, 'tc-mcp', ?, ?, 'img', '/work', 'none', '[]', '{}', ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    const ms = (offset: number) => new Date(Date.parse(T0) + offset).toISOString();
    const script = `\n${'x'.repeat(200)}\nprint(2)\n`;
    const done = Number(insert.get(TRACE_RUN, 'python', script, 'error', 2, 'exit code 2', 500, ms(4_000), ms(4_500))!.id);
    const running = Number(insert.get(TRACE_RUN, 'bash', 'ls -la\necho hi', 'running', null, null, 0, ms(4_200), null)!.id);
    const result = runSpans(db, TRACE_RUN)!;
    const spans = byId(result);
    expect(spans.get(`sandbox:${done}`)).toMatchObject({
      startMs: 4_000,
      endMs: 4_500,
      status: 'error',
      error: 'exit code 2',
      ref: { kind: 'sandbox', sandboxExecId: done },
    });
    const label = spans.get(`sandbox:${done}`)!.label;
    expect(label.startsWith('python xxx')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(80);
    expect(spans.get(`sandbox:${running}`)).toMatchObject({ label: 'bash ls -la', startMs: 4_200, endMs: null, endAt: null, status: 'running', error: null });
    expectSorted(result.spans);
    expectParents(result.spans);
    // a database from before 020 has no table, and the spans then leave the sandbox out.
    db.exec('DROP TABLE sandbox_files; DROP TABLE sandbox_execs');
    expect(runSpans(db, TRACE_RUN)!.spans.some((span) => span.kind === 'sandbox')).toBe(false);
  });

  it('puts each parent before the spans inside it', async () => {
    const { t } = await seedM1();
    const { spans } = runSpans(t.db, TRACE_RUN)!;
    const position = new Map(spans.map((span, index) => [span.id, index]));
    expect(spans.filter((span) => span.parentId !== null && position.get(span.parentId)! > position.get(span.id)!).map((span) => span.id)).toEqual([]);
  });

  it('draws a model call whose response is not valid json, with no tool calls in it', async () => {
    const { t, dashboard } = await seedM1();
    const id = Number(
      t.db
        .prepare(
          `INSERT INTO model_calls (runId, slot, provider, model, inputTokens, outputTokens, costUsd, latencyMs, stopReason, request, response, createdAt)
           VALUES (?, 'main', 'fake', 'm', 1, 1, 0, 10, 'end_turn', '{}', 'not json', ?) RETURNING id`,
        )
        .get(TRACE_RUN, new Date(Date.parse(T0) + 19_000).toISOString())!.id,
    );
    const response = await dashboard.request(`/api/runs/${TRACE_RUN}/spans`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as RunSpans;
    expect(byId(result).get(`model:${id}`)).toMatchObject({ kind: 'model', startMs: 18_990, endMs: 19_000 });
    expect(result.spans.filter((span) => span.parentId === `model:${id}`)).toEqual([]);
  });

  it('answers 404 for a run that does not exist', async () => {
    const { dashboard } = await seedM1();
    const response = await dashboard.request('/api/runs/nosuch/spans');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'run not found' });
  });

  it('gives model and tool spans for a run of the dashboard seed', async () => {
    const { dashboard } = await seedDashboard();
    const result = (await (await dashboard.request('/api/runs/run-1/spans')).json()) as RunSpans;
    expect(result.runId).toBe('run-1');
    const kinds = result.spans.map((span) => span.kind);
    expect(kinds[0]).toBe('run');
    expect(kinds).toContain('model');
    expect(kinds).toContain('tool');
    const tools = result.spans.filter((span) => span.kind === 'tool');
    expect(tools.map((span) => span.label).sort()).toEqual(['goal_update', 'goals_set']);
    for (const tool of tools) expect(tool.parentId).toMatch(/^model:\d+$/);
    expect(tools.find((span) => span.label === 'goal_update')!.status).toBe('error');
    expect(result.spans.filter((span) => span.kind === 'approval')).toHaveLength(2);
    expectSorted(result.spans);
    expectParents(result.spans);
  });
});
