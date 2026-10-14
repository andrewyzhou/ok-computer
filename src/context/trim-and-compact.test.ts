import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestCaller } from '../../test/harness.js';
import { runAgent, type AgentDeps } from '../agent/loop.js';
import { repairSession } from '../agent/recovery.js';
import { parseConfig } from '../config/load.js';
import { openDb } from '../db/index.js';
import { appendEvent, listEvents, type EventInput } from '../events/log.js';
import { createMemoryTools } from '../memory/tools.js';
import { createFakeClient, fakeResponse, textStep, toolStep, type FakeStep } from '../models/fake.js';
import { createSlotRunner } from '../models/slots.js';
import type { ModelCall, ModelMessage } from '../models/types.js';
import { silentLogger } from '../observability/logger.js';
import { nowTool } from '../tools/now.js';
import { createToolRegistry } from '../tools/registry.js';
import { fullHistory, renderEvents } from './full-history.js';
import { DROPPED_HEADING, findIdentifiers, LEFT_OUT_HEADING, SUMMARY_HEADINGS, SUMMARY_PROMPT } from './summary.js';
import { chooseBoundary, createTrimAndCompact, FLUSH_DONE, FLUSH_PROMPT } from './trim-and-compact.js';

const WINDOW = 3000;
const TOOLS = ['memory_write', 'now'];
const BIG = 'X'.repeat(6000);

function setup(steps: FakeStep[], options: { tools?: string[] } = {}) {
  const parsed = parseConfig({
    slots: { main: { chain: ['fake/m'] }, compaction: { chain: ['fake/m'] } },
    pricing: { 'fake/m': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = openDb(':memory:');
  const memoryDir = mkdtempSync(join(tmpdir(), 'okc-ctx-'));
  const model = createFakeClient(steps);
  const clock = () => new Date('2026-10-13T03:15:00Z');
  const slots = createSlotRunner({ db, config: parsed.value, clients: { fake: model }, logger: silentLogger, sleep: async () => {}, clock });
  let ids = 0;
  const tools = createToolRegistry([nowTool, ...createMemoryTools({ db, memoryDir })]);
  const deps: AgentDeps = {
    db,
    slots,
    tools,
    caller: createTestCaller(db, tools, clock).caller,
    strategy: createTrimAndCompact({ db, slots, logger: silentLogger, clock, windowTokens: WINDOW }),
    logger: silentLogger,
    config: parsed.value,
    stablePrompt: () => 'stable system prompt',
    clock,
    newId: () => `run-${++ids}`,
  };
  const add = (events: EventInput[]) => events.forEach((e) => appendEvent(db, { sessionKey: 'main', runId: 'old', ...e }, clock()));
  const run = (text: string) =>
    runAgent(deps, {
      sessionKey: 'main',
      trigger: 'message',
      slot: 'main',
      channel: 'cli',
      allowedTools: options.tools ?? TOOLS,
      events: [{ type: 'user_message', payload: { text, channel: 'cli', chatId: 'local' } }],
    });
  const rows = () => db.prepare('SELECT id, sessionKey, runId, seq, type, payload, createdAt FROM events ORDER BY id').all();
  return { db, model, slots, memoryDir, add, run, rows, events: () => listEvents(db, 'main') };
}

const user = (text: string): EventInput => ({ type: 'user_message', payload: { text, channel: 'cli', chatId: 'local' } });
const thinking = { type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkB' };
const assistant = (text: string, toolCalls: Array<{ id: string; name: string; input: unknown }> = []): EventInput => ({
  type: 'assistant_message',
  payload: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    content: [thinking, ...(text ? [{ type: 'text', text }] : []), ...toolCalls.map((c) => ({ type: 'tool_use', ...c }))],
    text,
    toolCalls,
    stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
  },
});

// the seeded session is over the trigger of a 3000-token window. the last turn is short, so it stays in the kept part.
function seed(add: (events: EventInput[]) => void) {
  add([
    user('Plan the trip. The flight is on 2026-11-02 at 07:45, booking #4417, see https://example.com/trip and data/memory/trip.md.'),
    { type: 'context', payload: { text: '<context>\ncurrent time: Sunday 20:00\n</context>' } },
    assistant('', [{ id: 'toolu_1', name: 'now', input: {} }]),
    { type: 'tool_result', payload: { toolCallId: 'toolu_1', name: 'now', content: BIG, isError: false } },
    assistant('The trip is planned.'),
    user(`Some background about packing. ${'blah '.repeat(300)}`),
    assistant('Noted.'),
    user('I like aisle seats.'),
    assistant('Got it.'),
  ]);
}

const validSummary = [
  SUMMARY_HEADINGS[0],
  '- trip on 2026-11-02 at 07:45',
  SUMMARY_HEADINGS[1],
  '- booking #4417',
  SUMMARY_HEADINGS[2],
  '- none',
  SUMMARY_HEADINGS[3],
  '- https://example.com/trip and data/memory/trip.md',
  SUMMARY_HEADINGS[4],
  '- the trip is planned',
].join('\n');

const flushSteps: FakeStep[] = [toolStep({ id: 'm1', name: 'memory_write', input: { text: 'The owner likes aisle seats.' } }), textStep('NO_REPLY')];

const roles = (call: ModelCall) => call.messages.map((m) => m.role);

describe('trim-and-compact strategy', () => {
  it('renders like full history while the session is under the trigger', async () => {
    const t = setup([textStep('hello')]);
    t.add([user('hi'), assistant('hello'), user('again')]);
    const events = t.events();
    const strategy = createTrimAndCompact({ db: t.db, slots: undefined as never, logger: silentLogger, clock: () => new Date(), windowTokens: WINDOW });
    const input = { sessionKey: 'main', events, system: 's', tools: [] };
    expect(await strategy.build(input)).toEqual(await fullHistory.build(input));
  });

  it('flushes memory, compacts with all headings, keeps the raw log and keeps the prefix stable afterwards', async () => {
    const summaryCalls: ModelCall[] = [];
    const t = setup([
      ...flushSteps,
      async (call) => {
        summaryCalls.push(structuredClone(call));
        return fakeResponse({ text: validSummary });
      },
      textStep('Next is packing.'),
      textStep('You are welcome.'),
    ]);
    seed(t.add);
    const before = t.rows();

    const first = await t.run('What is next?');
    expect(first).toMatchObject({ status: 'completed', text: 'Next is packing.' });

    // the raw events stay as they were. the run only appended new events.
    const after = t.rows();
    expect(after.slice(0, before.length)).toEqual(before);
    const added = t.events().slice(before.length).map((e) => e.type);
    expect(added).toEqual([
      'user_message',
      'context',
      'system_event',
      'context',
      'assistant_message',
      'tool_result',
      'assistant_message',
      'system_event',
      'compaction',
      'assistant_message',
    ]);

    // the flush ran in the same session and wrote the daily note.
    const flushCall = t.model.calls[0]!;
    expect(JSON.stringify(flushCall.messages.at(-1))).toContain(FLUSH_PROMPT);
    expect(readFileSync(join(t.memoryDir, 'daily', '2026-10-12.md'), 'utf8')).toContain('The owner likes aisle seats.');

    // the summary request gets the fixed prompt and a transcript of the old part.
    expect(summaryCalls[0]!.system).toBe(SUMMARY_PROMPT);
    expect(summaryCalls[0]!.tools).toEqual([]);
    const sent = JSON.stringify(summaryCalls[0]!.messages);
    expect(sent).toContain('owner: Plan the trip.');
    expect(sent).not.toContain('EqQBCkYIBxgCKkB');

    const compaction = t.events().find((e) => e.type === 'compaction')!;
    expect(compaction.type === 'compaction' && compaction.payload).toMatchObject({ summary: validSummary, model: 'm' });
    if (compaction.type !== 'compaction') throw new Error('no compaction');
    for (const heading of SUMMARY_HEADINGS) expect(compaction.payload.summary).toContain(heading);
    expect(compaction.payload.tokensAfter).toBeLessThan(compaction.payload.tokensBefore);
    const kept = t.events().find((e) => e.id === compaction.payload.firstKeptEventId)!;
    expect(kept.type).not.toBe('tool_result');

    // the model sees the summary first, then the kept events without thinking blocks, and the request ends with a user turn.
    const answer = t.model.calls[3]!;
    expect(answer.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: `<summary>\n${validSummary}\n</summary>` }] });
    const answerJson = JSON.stringify(answer.messages);
    expect(answerJson).not.toContain(BIG);
    expect(answerJson).not.toContain('"thinking"');
    expect(answerJson).toContain(FLUSH_DONE);
    expect(roles(answer).at(-1)).toBe('user');
    expect(t.db.prepare('SELECT slot FROM model_calls ORDER BY id').all().map((r) => r.slot)).toEqual(['main', 'main', 'compaction', 'main']);

    // the next run repeats the compacted request as an exact prefix, so the prompt cache works again.
    await t.run('thanks');
    const next = t.model.calls[4]!;
    expect(JSON.stringify(next.messages.slice(0, answer.messages.length))).toBe(JSON.stringify(answer.messages));
    expect(next.system).toBe(answer.system);
    expect(t.model.calls).toHaveLength(5);
  });

  it('flushes memory again before the second compaction', async () => {
    // the summary lists every identifier of the session as dropped, so it always passes validation.
    const summaryStep: FakeStep = async () =>
      fakeResponse({ text: `${validSummary}\n${DROPPED_HEADING}\n${findIdentifiers(t.events()).join(', ')}` });
    const t = setup([...flushSteps, summaryStep, textStep('Next is packing.'), ...flushSteps, summaryStep, textStep('Done.')]);
    seed(t.add);
    await t.run('What is next?');
    t.add([user(`More background. ${'blah '.repeat(2000)}`), assistant('Noted.'), user('Window seats are fine too.'), assistant('Got it.')]);
    await t.run('And then?');

    const flushes = t.events().filter((e) => e.type === 'system_event' && e.payload.text === FLUSH_PROMPT);
    expect(flushes).toHaveLength(2);
    expect(t.events().filter((e) => e.type === 'compaction')).toHaveLength(2);
    expect(t.db.prepare('SELECT slot FROM model_calls ORDER BY id').all().map((r) => r.slot)).toEqual([
      'main',
      'main',
      'compaction',
      'main',
      'main',
      'main',
      'compaction',
      'main',
    ]);
  });

  it('does not compact when every summary fails validation, and continues with trimming only', async () => {
    const bad = textStep('## decisions\n- the trip');
    const t = setup([...flushSteps, bad, bad, bad, toolStep({ id: 'n1', name: 'now', input: {} }), textStep('Next is packing.')]);
    seed(t.add);
    const before = t.rows();

    const result = await t.run('What is next?');
    expect(result).toMatchObject({ status: 'completed', text: 'Next is packing.' });
    expect(t.events().some((e) => e.type === 'compaction')).toBe(false);
    expect(t.rows().slice(0, before.length)).toEqual(before);

    // each retry names the failures of the attempt before it.
    const retry = JSON.stringify(t.model.calls[3]!.messages.at(-1));
    expect(retry).toContain('These headings are missing: ## goals and commitments');
    expect(retry).toContain('2026-11-02');
    expect(t.model.calls[3]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    // the trimmed view leaves out the long old tool result, and the same run does not try to compact again.
    for (const call of t.model.calls.slice(5)) {
      expect(JSON.stringify(call.messages)).not.toContain(BIG);
      expect(roles(call).at(-1)).toBe('user');
    }
    expect(t.db.prepare('SELECT slot FROM model_calls ORDER BY id').all().map((r) => r.slot)).toEqual([
      'main',
      'main',
      'compaction',
      'compaction',
      'compaction',
      'main',
      'main',
    ]);
  });

  it('keeps a summary that has every heading but left out identifiers, and adds them in code', async () => {
    const noIds = textStep(SUMMARY_HEADINGS.join('\n- x\n') + '\n- x');
    const t = setup([...flushSteps, noIds, noIds, noIds, textStep('Next is packing.')]);
    seed(t.add);
    await t.run('What is next?');
    const compaction = t.events().find((e) => e.type === 'compaction');
    if (compaction?.type !== 'compaction') throw new Error('no compaction');
    expect(compaction.payload.summary).toContain(`${LEFT_OUT_HEADING}\n- `);
    for (const id of ['2026-11-02', '07:45', '#4417', 'https://example.com/trip', 'data/memory/trip.md']) {
      expect(compaction.payload.summary).toContain(id);
    }
  });

  // a failed compaction cost a flush and three summary calls, and the next run of the session paid it again.
  it('tries again after a failed compaction only when the session grew by a quarter, and compacts once in a run', async () => {
    const bad = textStep('## decisions\n- the trip');
    const good: FakeStep = async () => fakeResponse({ text: `${validSummary}\n${DROPPED_HEADING}\n${findIdentifiers(t.events()).join(', ')}` });
    // the build gets no memory_write tool, so it does not flush.
    const t = setup([bad, bad, bad, good]);
    seed(t.add);
    const strategy = createTrimAndCompact({ db: t.db, slots: t.slots, logger: silentLogger, clock: () => new Date(), windowTokens: WINDOW });
    const hooks = (runId: string) => ({ runId, signal: new AbortController().signal, flush: async () => ({ status: 'completed', text: 'NO_REPLY' }) });
    const build = (runId: string) => strategy.build({ sessionKey: 'main', events: t.events(), system: 's', tools: [], compaction: hooks(runId) });
    const summaries = () => t.db.prepare("SELECT count(*) AS n FROM model_calls WHERE slot = 'compaction'").get()!.n;
    for (const id of ['r1', 'r2', 'r3']) {
      t.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'running', '')").run(id);
    }

    await build('r1');
    expect(summaries()).toBe(3);
    await build('r2');
    expect(summaries()).toBe(3);

    // the session grows by more than a quarter, so the next run tries again, and this time the summary is good.
    t.add([user(`More. ${'blah '.repeat(800)}`), assistant('Noted.'), user('Go on.')]);
    await build('r3');
    expect(summaries()).toBe(4);
    expect(t.events().filter((e) => e.type === 'compaction')).toHaveLength(1);

    // the same run goes over the trigger again, but it uses trimming and does not compact a second time.
    t.add([user(`Even more. ${'blah '.repeat(1500)}`)]);
    const again = await build('r3');
    expect(summaries()).toBe(4);
    expect(JSON.stringify(again.messages)).not.toContain(BIG);
  });

  it('skips the flush when the session cannot write memory', async () => {
    const t = setup([async () => fakeResponse({ text: validSummary }), textStep('ok')], { tools: ['now'] });
    seed(t.add);
    await t.run('What is next?');
    expect(t.model.calls[0]!.system).toBe(SUMMARY_PROMPT);
    expect(t.events().some((e) => e.type === 'system_event' && e.payload.text === FLUSH_PROMPT)).toBe(false);
    expect(t.events().some((e) => e.type === 'compaction')).toBe(true);
  });
});

describe('the compaction boundary', () => {
  // a tool_result block is valid only when the message just before it is an assistant turn with that call.
  const orphanResults = (messages: ModelMessage[]) =>
    messages.flatMap((message, i) => {
      if (message.role !== 'user') return [];
      const prev = messages[i - 1];
      const ids = new Set(prev?.role === 'assistant' ? prev.toolCalls.map((call) => call.id) : []);
      return message.content.flatMap((block) => (block.type === 'tool_result' && !ids.has(block.toolCallId) ? [block.toolCallId] : []));
    });

  // after a crash, the repaired result comes after the events that arrived while the process was down. a boundary on
  // such an event kept the result and summarized its call away, and every later request of the session failed.
  it('never keeps a repaired result without its call', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-13T03:15:00Z');
    for (const id of ['r1', 'r2']) {
      db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'running', 'x')").run(id);
    }
    const add = (runId: string | null, event: EventInput) => appendEvent(db, { sessionKey: 'main', runId, ...event }, now);
    add('r1', user('older talk '.repeat(200)));
    add('r1', assistant('older answer '.repeat(200)));
    add('r1', user('please save a note'));
    add('r1', assistant('', [{ id: 'toolu_1', name: 'memory_write', input: { text: 'n' } }]));
    // the process stops while the tool runs. after the restart a relay arrives, and then the next run repairs the call.
    add(null, { type: 'system_event', payload: { text: 'automation result '.repeat(50) } });
    repairSession(db, 'main', () => now);
    add('r2', user('did it work? '.repeat(50)));
    add('r2', assistant('newer answer '.repeat(300)));

    const live = listEvents(db, 'main');
    expect(live.map((event) => event.type)).toContain('tool_result');
    const broken: number[] = [];
    for (let keep = 1; keep <= 5000; keep += 7) {
      const boundary = chooseBoundary(live, keep);
      if (boundary > 0 && orphanResults(renderEvents(live.slice(boundary))).length) broken.push(keep);
    }
    expect(broken).toEqual([]);
  });
});
