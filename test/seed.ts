import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApproval, resolveApproval } from '../src/approvals/store.js';
import { createDashboard, type DashboardDeps } from '../src/dashboard/server.js';
import { appendEvent, listEvents } from '../src/events/log.js';
import { addGoal, updateGoal } from '../src/goals/store.js';
import { appendToDailyNote } from '../src/memory/daily.js';
import { fakeResponse, textStep, toolStep } from '../src/models/fake.js';
import { ModelError, type ModelCall } from '../src/models/types.js';
import { createLogger, silentLogger } from '../src/observability/logger.js';
import { setChecklist } from '../src/scheduler/heartbeat.js';
import { handleIn } from '../src/tools/results.js';
import { createTestApp } from './app-harness.js';
import { seedDesk } from './seed-desk.js';

export const pdt = (time: string, day = '2026-10-12') => new Date(`${day}T${time}:00-07:00`).toISOString();

// the weekly file is long, so memory_get gives the model a preview with a handle.
export const WEEKLY = [
  '# 2026-W42',
  '',
  '## trends',
  '',
  ...Array.from({ length: 150 }, (_, i) => (i === 75 ? '- late nights hurt sleep and the next morning' : `- day ${i}: steady work on the essay`)),
].join('\n');

const lastToolResult = (call: ModelCall) =>
  call.messages
    .flatMap((message) => (message.role === 'user' ? message.content : []))
    .findLast((block) => block.type === 'tool_result')!;

export const SUMMARY = [
  '## goals and commitments',
  '- finish essay by 21:00',
  '## decisions',
  '- none',
  '## open requests',
  '- none',
  '## facts and identifiers',
  '- goal #1',
  '## recent progress',
  '- goals are set',
].join('\n');

// the seed drives the real app with a fake model, so every row has the shape that the real code writes. it gives
// each dashboard page some data: runs with tool calls and an error, a heartbeat, a compaction, approvals, goals over
// several days, memory files and log lines.
export async function seedDashboard(options: Partial<Pick<DashboardDeps, 'token' | 'pollMs' | 'webDir'>> = {}) {
  const t = createTestApp(
    [
      toolStep(
        { id: 'call-goals', name: 'goals_set', input: { goals: [{ title: 'finish essay', eta: '21:00' }, { title: 'gym' }] } },
        { id: 'call-bad', name: 'goal_update', input: { id: 99, status: 'done' } },
      ),
      { text: 'Saved your two goals.', usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 0 } },
      textStep('You are welcome.'),
      new ModelError('request', 'the request was too large', 400),
      toolStep({ id: 'call-heartbeat', name: 'heartbeat_respond', input: { notify: false } }),
      textStep('NO_REPLY'),
      toolStep({ id: 'call-week', name: 'memory_get', input: { path: 'weekly/2026-W42.md' } }),
      async (call) => {
        const result = lastToolResult(call);
        const handle = result.type === 'tool_result' ? handleIn(result.content) : undefined;
        return fakeResponse({ model: call.model, toolCalls: [{ id: 'call-read', name: 'result_read', input: { handle, query: 'sleep' } }] });
      },
      textStep('Next is the essay check-in at 21:00.'),
    ],
    { start: pdt('18:00') },
  );
  const memoryDir = join(t.dataDir, 'memory');
  appendToDailyNote(memoryDir, '2026-10-12', 'notes', 'the owner wants short check-ins');
  mkdirSync(join(memoryDir, 'weekly'), { recursive: true });
  mkdirSync(join(memoryDir, 'history'), { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# memory\n\n- the owner writes essays in the evening\n');
  writeFileSync(join(memoryDir, 'weekly', '2026-W42.md'), WEEKLY);
  writeFileSync(join(memoryDir, 'consolidation-log.md'), '- 2026-10-12: weekly trends saved\n');
  writeFileSync(join(memoryDir, 'history', 'MEMORY.md.bak-2026-10-12'), 'old memory\n');

  await t.app.start();
  await t.say('my goals: essay by 21:00, and gym');
  await t.say('thanks');
  await t.say('please break');

  setChecklist(t.db, 'remind me when a goal eta is less than one hour away', t.clock());
  await t.at(pdt('18:30'));

  // the compaction keeps the events from the second owner message on.
  const kept = listEvents(t.db, 'main').find((event) => event.type === 'user_message' && event.payload.text === 'thanks')!;
  appendEvent(
    t.db,
    {
      sessionKey: 'main',
      runId: null,
      type: 'compaction',
      payload: { summary: SUMMARY, firstKeptEventId: kept.id, tokensBefore: 5000, tokensAfter: 900, model: 'm', clearToolResults: false },
    },
    t.clock(),
  );
  await t.say('what is next?');

  const pending = createApproval(t.db, { runId: 'run-1', toolName: 'now', input: {}, summary: 'now {}' }, t.clock());
  const denied = createApproval(t.db, { runId: 'run-1', toolName: 'now', input: {}, summary: 'now {"again":true}' }, t.clock());
  resolveApproval(t.db, denied.id, 'deny', 'command', t.clock());

  const history = [
    { day: '2026-10-10', done: [true, true, false] },
    { day: '2026-10-11', done: [true, true, true] },
  ];
  for (const { day, done } of history) {
    done.forEach((isDone, i) => {
      const goal = addGoal(t.db, { day, title: `goal ${i + 1}` }, t.clock());
      if (isDone) updateGoal(t.db, goal.id, { status: 'done' }, t.clock());
    });
  }

  const logger = createLogger({ dir: join(t.dataDir, 'logs'), consoleLevel: 'off', clock: t.clock });
  logger.info('run started', { runId: 'run-1' });
  logger.warn('transient model error', { runId: 'run-3' });
  logger.error('model request failed', { runId: 'run-3' });

  // the desk rows of phase 6 t3 (test/seed-desk.ts).
  seedDesk(t.db, t.clock());
  const dashboard = createDashboard({
    db: t.db,
    config: t.config,
    clock: t.clock,
    logger: silentLogger,
    app: t.app,
    webDir: join(t.dataDir, 'no-web'),
    ...options,
  });
  return { t, dashboard, pendingApprovalId: pending.id, deniedApprovalId: denied.id };
}
