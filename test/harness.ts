import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent, type AgentDeps, type RunInput } from '../src/agent/loop.js';
import { parseConfig } from '../src/config/load.js';
import { fullHistory } from '../src/context/full-history.js';
import { openDb, type Db } from '../src/db/index.js';
import { listEvents } from '../src/events/log.js';
import { createFakeClient, type FakeStep } from '../src/models/fake.js';
import { createSlotRunner } from '../src/models/slots.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { silentLogger } from '../src/observability/logger.js';
import { BUILTIN_RULES } from '../src/policy/policy.js';
import { createToolCaller, type ToolCallerDeps } from '../src/tools/caller.js';
import { nowTool } from '../src/tools/now.js';
import { createToolRegistry, defineTool, type ToolRegistry } from '../src/tools/registry.js';

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

// the caller of a test keeps its blobs in a new temporary folder. a call that needs approval fails, unless the test
// gives requestApproval.
export function createTestCaller(db: Db, tools: ToolRegistry, clock: () => Date, extra: Partial<ToolCallerDeps> = {}) {
  const blobs = createBlobStore(db, join(mkdtempSync(join(tmpdir(), 'okc-blobs-')), 'blobs'), clock);
  const caller = createToolCaller({
    db,
    blobs,
    tools,
    rules: BUILTIN_RULES,
    requestApproval: async () => {
      throw new Error('this test has no approvals');
    },
    clock,
    timeZone: 'America/Los_Angeles',
    ...extra,
  });
  return { caller, blobs };
}

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
  const tools = createToolRegistry([nowTool, failTool]);
  const deps: AgentDeps = {
    db,
    slots: createSlotRunner({ db, config, clients: { fake: model }, logger: silentLogger, sleep: async () => {}, clock }),
    tools,
    caller: createTestCaller(db, tools, clock).caller,
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
