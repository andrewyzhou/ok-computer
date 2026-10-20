import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalRow,
  AutomationRow,
  BlobBody,
  ContextView,
  CostPage,
  EventRow,
  GoalsPage,
  LogLine,
  ModelCallBody,
  Overview,
  RunDetail,
  RunRow,
  SessionRow,
  StreamMessage,
  ToolCatalog,
} from '../src/dashboard/types.js';
import { startDashboard } from '../src/dashboard/server.js';
import { appendEvent } from '../src/events/log.js';
import type { ModelCall } from '../src/models/types.js';
import { silentLogger } from '../src/observability/logger.js';
import { registerSecret } from '../src/observability/redact.js';
import { seedDashboard, SUMMARY, WEEKLY } from './seed.js';

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function get<T>(dashboard: { request: (path: string) => Response | Promise<Response> }, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

describe('the dashboard api on a seeded database', () => {
  it('gives the overview of today', async () => {
    const { dashboard } = await seedDashboard();
    const overview = await get<Overview>(dashboard, '/api/overview');
    expect(overview.day).toBe('2026-10-12');
    expect(overview.runs).toBe(5);
    expect(overview.failedRuns).toBe(1);
    expect(overview.modelErrors).toBe(1);
    expect(overview.costUsd).toBeGreaterThan(0);
    expect(overview.openGoals.map((goal) => goal.title)).toEqual(['finish essay', 'gym']);
    expect(overview.nextAutomations.length).toBe(5);
    expect(overview.blobs.count).toBeGreaterThan(0);
    expect(overview.blobs.bytes).toBeGreaterThan(WEEKLY.length);
    expect(overview.heartbeat).toMatchObject({
      every: '30m',
      inActiveHours: true,
      checklist: 'remind me when a goal eta is less than one hour away',
      lastRun: { status: 'completed' },
    });
  });

  it('lists runs with filters', async () => {
    const { dashboard } = await seedDashboard();
    const all = await get<RunRow[]>(dashboard, '/api/runs');
    expect(all.map((run) => run.id)).toEqual(['run-5', 'run-4', 'run-3', 'run-2', 'run-1']);
    expect((await get<RunRow[]>(dashboard, '/api/runs?status=failed')).map((run) => run.id)).toEqual(['run-3']);
    expect((await get<RunRow[]>(dashboard, '/api/runs?trigger=heartbeat')).map((run) => run.slot)).toEqual(['heartbeat']);
    expect(await get<RunRow[]>(dashboard, '/api/runs?day=2026-10-11')).toEqual([]);
    expect((await get<RunRow[]>(dashboard, '/api/runs?day=2026-10-12')).length).toBe(5);
  });

  it('shows the full timeline of a run, with each tool call inside its model call', async () => {
    const { dashboard } = await seedDashboard();
    const detail = await get<RunDetail>(dashboard, '/api/runs/run-1');
    expect(detail.run).toMatchObject({ status: 'completed', trigger: 'message', modelCalls: 2, toolCalls: 2 });
    expect(detail.timeline.map((item) => (item.kind === 'model' ? item.tools.map((tool) => tool.name) : item.call.name))).toEqual([
      ['goals_set', 'goal_update'],
      [],
    ]);
    const [first, last] = detail.timeline;
    expect(first?.kind === 'model' && first.call).toMatchObject({
      stopReason: 'tool_use',
      costUsd: expect.any(Number),
      toolCatalogHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      toolCount: 35,
    });
    const [set, bad] = first?.kind === 'model' ? first.tools : [];
    expect(set?.policy).toMatchObject({ decision: 'allow', rule: 'builtin:goals_set' });
    expect(bad).toMatchObject({ isError: true, input: { id: 99, status: 'done' }, riskLevel: 'write', policy: { decision: 'allow' } });
    expect(last?.kind === 'model' && last.call).toMatchObject({ cacheReadTokens: 800, stopReason: 'end_turn' });
    expect(detail.events.map((event) => event.type)).toEqual([
      'user_message',
      'context',
      'assistant_message',
      'tool_result',
      'tool_result',
      'assistant_message',
    ]);

    const body = await get<ModelCallBody>(dashboard, `/api/model-calls/${first?.call.id}`);
    expect(body.request).toMatchObject({ model: 'm', system: expect.stringContaining('USER.md') });
    // the row keeps the tool list only in its snapshot, and the body puts it back, so the page shows what the model saw.
    expect((body.request as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain('goals_list');
    expect(body.response).toMatchObject({ toolCalls: [{ id: 'call-goals' }, { id: 'call-bad' }] });

    const failed = await get<RunDetail>(dashboard, '/api/runs/run-3');
    expect(failed.run.error).toContain('the request was too large');
    expect(failed.timeline).toMatchObject([{ kind: 'model', call: { error: 'the request was too large', costUsd: null } }]);
    expect((await dashboard.request('/api/runs/nope')).status).toBe(404);
  });

  it('shows the preview that the model got for a large result, its handle, the full blob, and the policy decision', async () => {
    const { dashboard } = await seedDashboard();
    const detail = await get<RunDetail>(dashboard, '/api/runs/run-5');
    const tools = detail.timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call]));
    expect(tools.map((tool) => tool.name)).toEqual(['memory_get', 'result_read']);
    const [week, read] = tools;
    expect(week).toMatchObject({
      truncated: true,
      resultHandle: expect.stringMatching(/^res_[0-9a-f]{12}$/),
      riskLevel: 'read',
      tainted: false,
      policy: { decision: 'allow', rule: 'risk:read', reason: 'memory_get only reads', approvalId: null },
    });
    expect(week!.output.content).toContain(`the full result is ${week!.resultHandle}`);
    expect(week!.output.content).not.toContain('late nights hurt sleep');

    const raw = await get<BlobBody>(dashboard, `/api/blobs/${week!.rawResultBlob}`);
    expect(raw.text).toBe(`weekly/2026-W42.md lines 1-154 of 154:
${WEEKLY}`);
    expect(raw.size).toBe(raw.text.length);

    // the model view in the row is, byte for byte, the tool result in the next request that the model got.
    const next = detail.timeline[1]!;
    const body = await get<ModelCallBody>(dashboard, `/api/model-calls/${next.call.id}`);
    const sent = (body.request as ModelCall).messages
      .flatMap((message) => (message.role === 'user' ? message.content : []))
      .find((block) => block.type === 'tool_result' && block.toolCallId === week!.toolCallId);
    expect(sent).toMatchObject({ type: 'tool_result', content: week!.output.content });

    expect(read).toMatchObject({ input: { handle: week!.resultHandle, query: 'sleep' }, truncated: false, resultHandle: null });
    expect(read!.output.content).toContain('late nights hurt sleep and the next morning');

    const first = detail.timeline[0]!;
    const catalog = await get<ToolCatalog>(dashboard, `/api/tool-catalogs/${first.kind === 'model' ? first.call.toolCatalogHash : ''}`);
    expect(catalog.tools.map((tool) => tool.name)).toContain('result_read');
    expect((await dashboard.request(`/api/blobs/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await dashboard.request('/api/blobs/..%2F..%2Fokc.sqlite')).status).toBe(404);
    expect((await dashboard.request('/api/tool-catalogs/nope')).status).toBe(404);
  });

  it('lists sessions and gives the raw log with the compaction marker', async () => {
    const { dashboard } = await seedDashboard();
    const sessions = await get<SessionRow[]>(dashboard, '/api/sessions');
    expect(sessions.map((session) => session.sessionKey)).toEqual(['main', 'heartbeat:run-4']);
    expect(sessions[0]).toMatchObject({ compactions: 1 });
    const events = await get<EventRow[]>(dashboard, '/api/sessions/main/events');
    expect(events.filter((event) => event.type === 'compaction')).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'user_message', payload: { text: 'my goals: essay by 21:00, and gym' } });
    const heartbeat = await get<EventRow[]>(dashboard, `/api/sessions/${encodeURIComponent('heartbeat:run-4')}/events`);
    expect(heartbeat.map((event) => event.type)).toContain('tool_result');
  });

  it('shows what the model saw, the same as the context strategy gave the model', async () => {
    const { t, dashboard } = await seedDashboard();
    const view = await get<ContextView>(dashboard, '/api/sessions/main/context');
    const lastCall = t.model.calls.at(-1)!;
    // the view also has the reply to the last call, because the run appended it after the call.
    expect(view.messages.slice(0, -1)).toEqual(lastCall.messages);
    expect(view.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Next is the essay check-in at 21:00.' });
    expect(view.system).toBe(lastCall.system);
    expect(view.tools.map((tool) => tool.name)).toEqual(lastCall.tools.map((tool) => tool.name));
    expect(view.estimatedTokens).toBeGreaterThan(0);
    // the compaction replaced the first turn with the summary.
    const text = JSON.stringify(view.messages);
    expect(text).toContain(SUMMARY.split('\n')[0]);
    expect(text).not.toContain('my goals: essay by 21:00');

    const heartbeat = await get<ContextView>(dashboard, `/api/sessions/${encodeURIComponent('heartbeat:run-4')}/context`);
    expect(heartbeat.tools.map((tool) => tool.name)).toEqual(['goals_list', 'heartbeat_respond', 'now']);
  });

  it('lists automations and their history, toggles them and runs one now', async () => {
    const { t, dashboard } = await seedDashboard();
    const list = await get<AutomationRow[]>(dashboard, '/api/automations');
    const heartbeat = list.find((automation) => automation.payloadType === 'heartbeat')!;
    const ask = list.find((automation) => automation.name === 'goals: ask')!;
    expect(ask.schedule).toContain('every day at 19:00');
    expect(await get(dashboard, `/api/automations/${heartbeat.id}/runs`)).toMatchObject([{ status: 'completed', runId: 'run-4' }]);

    const off = await dashboard.request(`/api/automations/${ask.id}`, json({ enabled: false }));
    expect(await off.json()).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await dashboard.request(`/api/automations/${ask.id}`, json({ enabled: true }));
    expect(await on.json()).toMatchObject({ enabled: true, nextRunAt: '2026-10-13T02:00:00.000Z' });
    expect((await dashboard.request(`/api/automations/${ask.id}`, json({ enabled: 'yes' }))).status).toBe(400);

    const results = list.find((automation) => automation.payloadType === 'goals_results')!;
    const started = await dashboard.request(`/api/automations/${results.id}/run`, json({}));
    expect(started.status).toBe(202);
    await vi.waitFor(() =>
      expect(t.rows('SELECT status FROM automation_runs WHERE automationId = ?', results.id)).toEqual([{ status: 'completed' }]),
    );
    expect((await dashboard.request('/api/automations/nope/run', json({}))).status).toBe(404);
  });

  it('edits the heartbeat checklist', async () => {
    const { dashboard } = await seedDashboard();
    const response = await dashboard.request('/api/heartbeat/checklist', json({ checklist: '  check email  ' }, 'PUT'));
    expect(await response.json()).toMatchObject({ checklist: 'check email' });
    expect(await get(dashboard, '/api/heartbeat')).toMatchObject({ checklist: 'check email' });
  });

  it('gives goals for today and the last 30 days with stats', async () => {
    const { dashboard } = await seedDashboard();
    const goals = await get<GoalsPage>(dashboard, '/api/goals');
    expect(goals.today).toBe('2026-10-12');
    expect(goals.days).toHaveLength(30);
    expect(goals.days.slice(-3)).toEqual([
      { day: '2026-10-10', goals: 3, done: 2 },
      { day: '2026-10-11', goals: 3, done: 3 },
      { day: '2026-10-12', goals: 2, done: 0 },
    ]);
    expect(goals.stats7).toMatchObject({ goals: 8, done: 5, setStreak: 3 });
  });

  it('lists approvals and resolves one from the dashboard', async () => {
    const { t, dashboard, pendingApprovalId, deniedApprovalId } = await seedDashboard();
    const approvals = await get<ApprovalRow[]>(dashboard, '/api/approvals');
    expect(approvals.map((approval) => [approval.id, approval.status])).toEqual([
      [pendingApprovalId, 'pending'],
      [deniedApprovalId, 'denied'],
    ]);
    // the stored input is not redacted, because the tool runs with it. the dashboard redacts it.
    const secret = `dashboard-secret-${'z'.repeat(20)}`;
    registerSecret(secret);
    t.db.prepare('UPDATE approvals SET input = ? WHERE id = ?').run(JSON.stringify({ to: 'bob', key: secret }), deniedApprovalId);
    const denied = (await get<ApprovalRow[]>(dashboard, '/api/approvals')).find((approval) => approval.id === deniedApprovalId);
    expect(denied?.input).toEqual({ to: 'bob', key: '[redacted]' });
    const response = await dashboard.request(`/api/approvals/${pendingApprovalId}`, json({ decision: 'approve' }));
    expect(((await response.json()) as { message: string }).message).toMatch(/^Approved #1\. Result: /);
    expect(t.rows('SELECT status, resolvedBy FROM approvals WHERE id = ?', pendingApprovalId)).toEqual([
      { status: 'approved', resolvedBy: 'dashboard' },
    ]);
    const again = await dashboard.request(`/api/approvals/${pendingApprovalId}`, json({ decision: 'deny' }));
    expect(await again.json()).toEqual({ message: 'Approval #1 is already approved.' });
  });

  it('browses the memory files without the backups', async () => {
    const { dashboard } = await seedDashboard();
    const files = await get<Array<{ path: string }>>(dashboard, '/api/memory');
    expect(files.map((file) => file.path)).toEqual([
      'MEMORY.md',
      'consolidation-log.md',
      'weekly/2026-W42.md',
      'daily/2026-10-12.md',
    ]);
    const note = await get<{ text: string }>(dashboard, '/api/memory/file?path=daily/2026-10-12.md');
    expect(note.text).toContain('the owner wants short check-ins');
    expect((await dashboard.request('/api/memory/file?path=../okc.sqlite')).status).toBe(404);
    expect((await dashboard.request('/api/memory/file?path=../../USER.md')).status).toBe(404);
  });

  it('gives the cost by day, slot and model', async () => {
    const { t, dashboard } = await seedDashboard();
    const cost = await get<CostPage>(dashboard, '/api/cost');
    const total = Number(t.rows('SELECT SUM(costUsd) AS total FROM model_calls')[0]!.total);
    expect(cost.days).toHaveLength(30);
    expect(cost.days.at(-1)).toMatchObject({ key: '2026-10-12', calls: 9 });
    expect(cost.days.at(-1)!.costUsd).toBeCloseTo(total);
    expect(cost.slots.map((group) => group.key).sort()).toEqual(['heartbeat', 'main']);
    expect(cost.models).toMatchObject([{ key: 'fake/m', calls: 9 }]);
    expect(cost.unpricedCalls).toBe(0);
  });

  it('gives log lines with a level filter', async () => {
    const { dashboard } = await seedDashboard();
    expect((await get<LogLine[]>(dashboard, '/api/logs')).map((line) => line.msg)).toEqual([
      'run started',
      'transient model error',
      'model request failed',
    ]);
    expect((await get<LogLine[]>(dashboard, '/api/logs?level=warn')).map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('streams new events and run changes', async () => {
    const { t, dashboard } = await seedDashboard({ pollMs: 5 });
    const response = await dashboard.request('/api/stream');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = '';
    const until = async (text: string) => {
      while (!received.includes(text)) received += (await reader.read()).value ?? '';
    };
    await until('event: ready');
    appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'note', payload: { text: 'a new note' } }, t.clock());
    await until('a new note');
    await reader.cancel();
    const data = received
      .split('\n')
      .filter((line) => line.startsWith('data: {"kind"'))
      .map((line) => JSON.parse(line.slice(6)) as StreamMessage);
    expect(data).toMatchObject([{ kind: 'event', event: { type: 'note', payload: { text: 'a new note' } } }]);
  });

  // a stop closes the database while a stream waits for its next poll. the stream must end, not read a closed database.
  it('ends a stream when the database closes', async () => {
    const { t, dashboard } = await seedDashboard({ pollMs: 5 });
    const response = await dashboard.request('/api/stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = '';
    while (!received.includes('event: ready')) received += (await reader.read()).value ?? '';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      t.db.close();
      let done = false;
      while (!done) done = (await reader.read()).done;
      await new Promise((settle) => setTimeout(settle, 20));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('the dashboard server', () => {
  it('listens on the loopback address and closes while a stream is open', async () => {
    const { t } = await seedDashboard();
    const server = await startDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app, port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const meta = await fetch(`${base}/api/meta`);
    // the server keeps the global Response class. the mcp sdk reads a failed token refresh with instanceof Response.
    expect(meta instanceof Response).toBe(true);
    expect(await meta.json()).toEqual({ timeZone: 'America/Los_Angeles', now: t.clock().toISOString() });
    const stream = await fetch(`${base}/api/stream`);
    expect(stream.status).toBe(200);
    await server.close();
    await expect(fetch(`${base}/api/meta`)).rejects.toThrow();
  });
});

describe('dashboard access', () => {
  it('refuses hosts other than loopback, writes without json, and a wrong token', async () => {
    const { dashboard } = await seedDashboard({ token: 'secret-token' });
    expect((await dashboard.request('http://evil.example/api/meta?token=secret-token')).status).toBe(403);
    expect((await dashboard.request('/api/meta')).status).toBe(401);
    expect((await dashboard.request('/api/meta?token=wrong')).status).toBe(401);
    expect((await dashboard.request('/api/meta?token=secret-token')).status).toBe(200);
    const auth = { authorization: 'Bearer secret-token' };
    expect((await dashboard.request('/api/meta', { headers: auth })).status).toBe(200);
    const form = await dashboard.request('/api/approvals/1', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'decision=approve',
    });
    expect(form.status).toBe(415);
    expect((await dashboard.request('/', {})).status).toBe(200);
  });
});
