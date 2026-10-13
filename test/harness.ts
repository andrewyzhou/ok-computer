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
import type { ModelMessage } from '../src/models/types.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { silentLogger } from '../src/observability/logger.js';
import { BUILTIN_RULES } from '../src/policy/policy.js';
import { createRunQueue } from '../src/sessions/queue.js';
import { createToolCaller, type ToolCallerDeps } from '../src/tools/caller.js';
import { nowTool } from '../src/tools/now.js';
import { createToolRegistry, defineTool, type Tool, type ToolRegistry } from '../src/tools/registry.js';

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

// a request is valid only when each tool call of an assistant turn has its result in the next user message, and
// the results come before any text in that message. the function gives the ids of the calls that break a rule.
export function danglingToolCalls(messages: ModelMessage[]): string[] {
  const bad: string[] = [];
  messages.forEach((message, i) => {
    if (message.role !== 'assistant' || !message.toolCalls.length) return;
    const next = messages[i + 1];
    const blocks = next?.role === 'user' ? next.content : [];
    const firstText = blocks.findIndex((block) => block.type === 'text');
    for (const call of message.toolCalls) {
      const at = blocks.findIndex((block) => block.type === 'tool_result' && block.toolCallId === call.id);
      if (at === -1 || (firstText !== -1 && at > firstText)) bad.push(call.id);
    }
  });
  return bad;
}

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
    queue: createRunQueue(),
    logger: silentLogger,
    clock,
    timeZone: 'America/Los_Angeles',
    ...extra,
  });
  return { caller, blobs };
}

// the harness wires the real modules together. only the model is fake, and the clock is fixed. a test can give more
// tools, and a database file to open again as a new process would.
export function createHarness(
  steps: FakeStep[],
  overrides: { maxIterations?: number; chatTimeoutMs?: number } = {},
  options: { tools?: Tool[]; db?: Db; idPrefix?: string } = {},
) {
  const parsed = parseConfig({
    slots: { main: { chain: ['fake/test-model'], effort: 'low' } },
    pricing: { 'fake/test-model': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
    agent: overrides,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const config = parsed.value;
  const db = options.db ?? openDb(':memory:');
  const model = createFakeClient(steps);
  let ids = 0;
  const clock = () => new Date('2026-10-13T03:15:00Z');
  const extra = options.tools ?? [];
  const tools = createToolRegistry([nowTool, failTool, ...extra]);
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
    newId: () => `${options.idPrefix ?? 'run'}-${++ids}`,
  };
  const run = (text: string, input: Partial<RunInput> = {}) =>
    runAgent(deps, {
      sessionKey: 'main',
      trigger: 'message',
      slot: 'main',
      channel: 'cli',
      allowedTools: [...TEST_TOOLS, ...extra.map((tool) => tool.name)],
      events: [{ type: 'user_message', payload: { text, channel: 'cli', chatId: 'local' } }],
      ...input,
    });
  const rows = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
  return { db, deps, model, run, rows, events: () => listEvents(db, 'main') };
}
