import { join } from 'node:path';
import { createDashboard } from '../src/dashboard/server.js';
import { appendEvent } from '../src/events/log.js';
import { silentLogger } from '../src/observability/logger.js';
import { REPLY_CALL_ID, REPLY_NOTE, REPLY_TOOL } from '../src/policy/reply.js';
import { pdt, seedDashboard } from './seed.js';

// the start of the traced run. each time of its rows is an offset in ms from it, so a test can check the span math
// with exact numbers.
export const T0 = pdt('18:30');
export const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
export const TRACE_RUN = 'trace-1';
export const CHILD_RUN = 'trace-1-child';
export const CHILD_SESSION = `sub:research:${CHILD_RUN}`;
// the dashboard of this seed reads the clock one minute after the start, so an open span ends at a known now.
export const NOW = at(60_000);
export const GUARDED_REPLY = 'The 9:10 train fits. The fares are at https://rail.example/fares?d=owner-notes';
export const GUARD_NOTE = `${REPLY_NOTE}: the reviewer held it, so the chat got it without the links that can carry data.`;

// the seed of phase 5 m1 adds the rows that the chats, the search, the spans, the live browser view and the new
// stream kinds read, on top of the dashboard seed. the owner sends /new through the real app, so the main session
// has a session_reset. then one run after the reset, trace-1, has a row of each traced kind at a known offset: model
// calls, a reviewer call, tool calls, an mcp request and its answer, a google request, an open browser task with two
// steps, a sub-agent with its child run, a pending approval, and a reply that the guard held. the rows have the
// columns that the real code writes. the event log is only appended to.
//
// offsets of trace-1 in ms:
//   run                0 - 20000   completed
//   model (turn 1)     0 -  2000   asks for gmail_search, browser_open, fs__read and delegate
//   google request  2500 -  3400   from gmail_search
//   tool gmail_search 2500 - 4000
//   tool browser_open 2000 - 6000
//   browser step open 2200 - 3000, browser step snapshot 5000 - 5500 (task bt_live stays open)
//   tool fs__read     3000 - 5000   mcp tools/call out at 3200, answer in at 4700
//   tool delegate     3000 - 14000  child run trace-1-child 3000 - 13000, child model 4000 - 12000
//   model (turn 2)  15000 - 18000   the final reply
//   review          16000 - 17500   the reviewer call of the reply guard, verdict hold
//   approval        16000 - open    browser_submit, still pending
export async function seedM1() {
  const seeded = await seedDashboard();
  const { t } = seeded;
  // the real router writes the reset and answers it without a run.
  await t.say('/new');
  const resetEventId = Number(t.db.prepare("SELECT MAX(id) AS id FROM events WHERE sessionKey = 'main' AND type = 'session_reset'").get()!.id);

  const db = t.db;
  db.prepare(
    "INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt, endedAt) VALUES (?, 'main', 'message', 'main', 'completed', ?, ?)",
  ).run(TRACE_RUN, at(0), at(20_000));
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt, endedAt) VALUES (?, ?, 'subagent', 'main', 'completed', ?, ?)").run(
    CHILD_RUN,
    CHILD_SESSION,
    at(3_000),
    at(13_000),
  );

  const owner = appendEvent(
    db,
    { sessionKey: 'main', runId: TRACE_RUN, type: 'user_message', payload: { text: 'plan the trip to the coast', channel: 'web', chatId: 'web' } },
    new Date(at(0)),
  );
  const calls = [
    { id: 'tc-gmail', name: 'gmail_search', input: { query: 'train tickets' } },
    { id: 'tc-browser', name: 'browser_open', input: { url: 'https://rail.example/' } },
    { id: 'tc-mcp', name: 'fs__read', input: { path: 'trips.md' } },
    { id: 'tc-sub', name: 'delegate', input: { profile: 'research', task: 'find the ferry times' } },
  ];
  const turn = (text: string, toolCalls: typeof calls) => ({
    provider: 'fake',
    model: 'm',
    content: [...(text ? [{ type: 'text', text }] : []), ...toolCalls.map((call) => ({ type: 'tool_use', ...call }))],
    text,
    toolCalls,
    stopReason: toolCalls.length ? ('tool_use' as const) : ('end_turn' as const),
  });
  appendEvent(db, { sessionKey: 'main', runId: TRACE_RUN, type: 'assistant_message', payload: turn('', calls) }, new Date(at(2_000)));
  const results: Array<[string, string, number]> = [
    ['tc-gmail', 'gmail_search', 4_000],
    ['tc-browser', 'browser_open', 6_000],
    ['tc-mcp', 'fs__read', 5_000],
    ['tc-sub', 'delegate', 14_000],
  ];
  for (const [toolCallId, name, ms] of results) {
    appendEvent(
      db,
      { sessionKey: 'main', runId: TRACE_RUN, type: 'tool_result', payload: { toolCallId, name, content: `the result of ${name}: ferry at 11:00`, isError: false } },
      new Date(at(ms)),
    );
  }
  const reply = appendEvent(db, { sessionKey: 'main', runId: TRACE_RUN, type: 'assistant_message', payload: turn(GUARDED_REPLY, []) }, new Date(at(18_000)));
  const note = appendEvent(db, { sessionKey: 'main', runId: TRACE_RUN, type: 'note', payload: { text: GUARD_NOTE } }, new Date(at(19_000)));

  appendEvent(
    db,
    { sessionKey: CHILD_SESSION, runId: CHILD_RUN, type: 'system_event', payload: { text: 'Your task from the parent agent:\nfind the ferry times' } },
    new Date(at(3_000)),
  );
  appendEvent(db, { sessionKey: CHILD_SESSION, runId: CHILD_RUN, type: 'assistant_message', payload: turn('The ferry leaves at 11:00.', []) }, new Date(at(12_000)));

  // a model call row is written when the answer is in, so createdAt is its end and latencyMs gives its start.
  const modelCall = (runId: string, endMs: number, latencyMs: number, costUsd: number, slot = 'main', toolCalls: typeof calls = []) =>
    Number(
      db
        .prepare(
          `INSERT INTO model_calls (runId, slot, provider, model, inputTokens, outputTokens, costUsd, latencyMs, stopReason, request, response, createdAt)
           VALUES (?, ?, 'fake', 'm', 1000, 50, ?, ?, ?, '{}', ?, ?) RETURNING id`,
        )
        .get(runId, slot, costUsd, latencyMs, toolCalls.length ? 'tool_use' : 'end_turn', JSON.stringify({ toolCalls }), at(endMs))!.id,
    );
  const turnOne = modelCall(TRACE_RUN, 2_000, 2_000, 0.01, 'main', calls);
  const childCall = modelCall(CHILD_RUN, 12_000, 8_000, 0.002);
  const reviewCall = modelCall(TRACE_RUN, 17_500, 1_500, 0.001, 'utility');
  const turnTwo = modelCall(TRACE_RUN, 18_000, 3_000, 0.02);

  // a tool call row is written when the tool ends, so createdAt is its end and durationMs gives its start.
  const toolCall = (toolCallId: string, name: string, endMs: number, durationMs: number, extra: { source?: string; serverId?: string; account?: string } = {}) =>
    Number(
      db
        .prepare(
          `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel, source, serverId, account)
           VALUES (?, ?, ?, '{}', '{"content":"ok"}', 0, ?, ?, 'read', ?, ?, ?) RETURNING id`,
        )
        .get(TRACE_RUN, toolCallId, name, durationMs, at(endMs), extra.source ?? 'builtin', extra.serverId ?? null, extra.account ?? null)!.id,
    );
  const gmailRow = toolCall('tc-gmail', 'gmail_search', 4_000, 1_500, { account: 'personal' });
  const browserRow = toolCall('tc-browser', 'browser_open', 6_000, 4_000);
  const mcpRow = toolCall('tc-mcp', 'fs__read', 5_000, 2_000, { source: 'mcp', serverId: 'fs' });
  const delegateRow = toolCall('tc-sub', 'delegate', 14_000, 11_000);

  // a google request row is written before the request leaves, so createdAt is its start.
  const googleRequestId = Number(
    db
      .prepare(
        `INSERT INTO google_requests (account, runId, toolCallId, method, url, status, latencyMs, createdAt)
         VALUES ('personal', ?, 'tc-gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=train', 200, 900, ?) RETURNING id`,
      )
      .get(TRACE_RUN, at(2_500))!.id,
  );

  // the out row of an mcp request is written when it leaves, and the in row of the answer when it comes back.
  const mcpOut = Number(
    db
      .prepare(
        `INSERT INTO mcp_messages (serverId, runId, toolCallId, direction, method, rpcId, payload, createdAt)
         VALUES ('fs', ?, 'tc-mcp', 'out', 'tools/call', '7', '{"method":"tools/call"}', ?) RETURNING id`,
      )
      .get(TRACE_RUN, at(3_200))!.id,
  );
  const mcpIn = Number(
    db
      .prepare(
        `INSERT INTO mcp_messages (serverId, runId, toolCallId, direction, method, rpcId, payload, latencyMs, createdAt)
         VALUES ('fs', ?, 'tc-mcp', 'in', NULL, '7', '{"result":{"content":[]}}', 1500, ?) RETURNING id`,
      )
      .get(TRACE_RUN, at(4_700))!.id,
  );

  // a browser step row is written after the action, so createdAt is its end and durationMs gives its start.
  db.prepare(
    `INSERT INTO browser_tasks (id, kind, sessionKey, runId, allowlist, status, startedAt) VALUES ('bt_live', 'task', 'main', ?, '["rail.example"]', 'open', ?)`,
  ).run(TRACE_RUN, at(2_000));
  const step = (action: string, endMs: number, durationMs: number, urlAfter: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO browser_steps (taskId, runId, toolCallId, action, target, urlBefore, urlAfter, durationMs, createdAt)
           VALUES ('bt_live', ?, 'tc-browser', ?, '"https://rail.example/"', 'about:blank', ?, ?, ?) RETURNING id`,
        )
        .get(TRACE_RUN, action, urlAfter, durationMs, at(endMs))!.id,
    );
  const openStep = step('open', 3_000, 800, 'https://rail.example/');
  const snapshotStep = step('snapshot', 5_500, 500, 'https://rail.example/times');

  db.prepare(`INSERT INTO subagent_runs (parentRunId, toolCallId, childRunId, profile, createdAt) VALUES (?, 'tc-sub', ?, 'research', ?)`).run(
    TRACE_RUN,
    CHILD_RUN,
    at(3_000),
  );

  const approvalId = Number(
    db
      .prepare(
        `INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES (?, 'browser_submit', '{}', 'browser_submit {"button":"Buy"}', 'pending', ?) RETURNING id`,
      )
      .get(TRACE_RUN, at(16_000))!.id,
  );
  const decision = (toolCallId: string, toolName: string, verdict: string, rule: string, ms: number, extra: { approvalId?: number; reviewer?: number }) =>
    Number(
      db
        .prepare(
          `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerModelCallId, reviewerVerdict, reviewerReason, approvalId, createdAt)
           VALUES (?, ?, ?, ?, ?, 'seeded', ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          TRACE_RUN,
          toolCallId,
          toolName,
          verdict,
          rule,
          extra.reviewer ?? null,
          extra.reviewer ? 'hold' : null,
          extra.reviewer ? 'the link carries notes' : null,
          extra.approvalId ?? null,
          at(ms),
        )!.id,
    );
  const approvalDecision = decision('tc-submit', 'browser_submit', 'approve', 'risk:external', 16_000, { approvalId });
  const replyDecision = decision(REPLY_CALL_ID, REPLY_TOOL, 'review', 'exfiltration', 16_000, { reviewer: reviewCall });

  const dashboard = createDashboard({
    db,
    config: t.config,
    clock: () => new Date(NOW),
    logger: silentLogger,
    app: t.app,
    webDir: join(t.dataDir, 'no-web'),
  });
  return {
    ...seeded,
    dashboard,
    resetEventId,
    ids: {
      ownerEvent: owner.id,
      replyEvent: reply.id,
      noteEvent: note.id,
      turnOne,
      turnTwo,
      reviewCall,
      childCall,
      gmailRow,
      browserRow,
      mcpRow,
      delegateRow,
      googleRequestId,
      mcpOut,
      mcpIn,
      openStep,
      snapshotStep,
      approvalId,
      approvalDecision,
      replyDecision,
    },
  };
}
