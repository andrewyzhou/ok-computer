import { z } from 'zod';
import { runAgent, type AgentDeps, type RunInput } from '../src/agent/loop.js';
import { parseConfig } from '../src/config/load.js';
import { fullHistory } from '../src/context/full-history.js';
import { openDb } from '../src/db/index.js';
import { listEvents } from '../src/events/log.js';
import { createFakeClient, type FakeStep } from '../src/models/fake.js';
import { createSlotRunner } from '../src/models/slots.js';
import { silentLogger } from '../src/observability/logger.js';
import { nowTool } from '../src/tools/now.js';
import { createToolRegistry, defineTool } from '../src/tools/registry.js';

export const failTool = defineTool({
  name: 'fail',
  description: 'Always fails.',
  input: z.object({}),
  risk: 'read',
  async run() {
    throw new Error('it broke');
  },
});

export const TEST_TOOLS = ['fail', 'now'];

// the harness wires the real modules together. only the model is fake, and the clock is fixed.
export function createHarness(steps: FakeStep[], overrides: { maxIterations?: number; chatTimeoutMs?: number } = {}) {
  const parsed = parseConfig({
    slots: { main: { chain: ['fake/test-model'], effort: 'low' } },
    pricing: { 'fake/test-model': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
    agent: overrides,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const config = parsed.value;
  const db = openDb(':memory:');
  const model = createFakeClient(steps);
  let ids = 0;
  const clock = () => new Date('2026-10-13T03:15:00Z');
  const deps: AgentDeps = {
    db,
    slots: createSlotRunner({ db, config, clients: { fake: model }, logger: silentLogger, sleep: async () => {}, clock }),
    tools: createToolRegistry([nowTool, failTool]),
    strategy: fullHistory,
    logger: silentLogger,
    config,
    stablePrompt: () => 'stable system prompt',
    clock,
    newId: () => `run-${++ids}`,
  };
  const run = (text: string, extra: Partial<RunInput> = {}) =>
    runAgent(deps, {
      sessionKey: 'main',
      trigger: 'message',
      slot: 'main',
      channel: 'cli',
      allowedTools: TEST_TOOLS,
      events: [{ type: 'user_message', payload: { text, channel: 'cli', chatId: 'local' } }],
      ...extra,
    });
  const rows = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
  return { db, deps, model, run, rows, events: () => listEvents(db, 'main') };
}
