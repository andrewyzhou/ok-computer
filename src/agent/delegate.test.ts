import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createRunQueue } from '../sessions/queue.js';
import type { ToolContext } from '../tools/registry.js';
import { createDelegateTool, PROFILES, type ProfileName } from './delegate.js';
import type { RunInput, RunResult } from './loop.js';

const clock = () => new Date('2026-10-13T16:00:00Z');

function setup(runChild: (input: RunInput) => Promise<RunResult>, toolsOf = (profile: ProfileName) => (profile === 'research' ? ['memory_search'] : [])) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('p', 'main', 'message', 'main', 'running', 'x')").run();
  let ids = 0;
  const tool = createDelegateTool({ db, clock, queue: createRunQueue(), newId: () => `c${++ids}`, toolsOf, runChild });
  const ctx = (sessionKey = 'main', toolCallId = 'd1'): ToolContext => ({
    runId: 'p',
    sessionKey,
    timeZone: 'UTC',
    clock,
    signal: new AbortController().signal,
    toolCallId,
  });
  return { db, tool, ctx };
}

const done = (runId: string, text: string): RunResult => ({ runId, status: 'completed', text });

describe('delegate', () => {
  it('has no profile that can delegate, and no code profile', () => {
    for (const profile of Object.values(PROFILES)) expect(profile.tools).not.toContain('delegate');
    expect(Object.keys(PROFILES)).toEqual(['browser', 'research', 'inbox']);
  });

  it('lists each profile with its tools when the app starts', () => {
    const { tool } = setup(async () => done('x', ''));
    expect(tool.description).toContain('- research: Searches the web');
    expect(tool.description).toContain('Tools: memory_search.');
    expect(tool.description).toContain('- inbox: Reads, labels and archives mail in bulk, and reports what it did. Tools: none in this app yet.');
  });

  it('starts the child with the profile tools, its limit and the parent taint, and links it to the call', async () => {
    const started: RunInput[] = [];
    const { db, tool, ctx } = setup(async (input) => {
      started.push(input);
      // a real run writes its start events into the child session.
      for (const event of input.events) appendEvent(db, { ...event, sessionKey: input.sessionKey, runId: input.runId! }, clock());
      return done(input.runId!, 'The answer.');
    });
    const taint = [{ source: 'gmail:personal', toolName: 'gmail_read', runId: 'p', toolCallId: 'm1', at: 'x' }];
    appendEvent(db, { sessionKey: 'main', runId: 'p', type: 'system_event', payload: { text: 'mail', taint } }, clock());
    expect(await tool.run({ profile: 'research', task: 'Find it.' }, ctx())).toEqual({
      content: 'The answer.',
      // the child starts tainted, so its result is untrusted too.
      untrustedSource: 'sub:research:c1 (gmail:personal)',
    });
    expect(started[0]).toMatchObject({
      runId: 'c1',
      sessionKey: 'sub:research:c1',
      trigger: 'subagent',
      slot: 'main',
      allowedTools: ['memory_search'],
      maxIterations: PROFILES.research.maxIterations,
      events: [{ type: 'system_event', payload: { text: 'Your task from the parent agent:\nFind it.', taint } }],
    });
    expect(db.prepare('SELECT parentRunId, toolCallId, childRunId, profile FROM subagent_runs').all()).toEqual([
      { parentRunId: 'p', toolCallId: 'd1', childRunId: 'c1', profile: 'research' },
    ]);
  });

  it('gives a trusted result for a child that read nothing untrusted', async () => {
    const { tool, ctx } = setup(async (input) => done(input.runId!, 'Nothing new.'));
    expect(await tool.run({ profile: 'research', task: 't' }, ctx())).toEqual({ content: 'Nothing new.' });
  });

  it('refuses a fourth child of the same run while three work, and runs it after one ends', async () => {
    const release: Array<() => void> = [];
    const { tool, ctx } = setup(
      (input) => new Promise((resolve) => release.push(() => resolve(done(input.runId!, `done ${input.runId}`)))),
    );
    const running = [1, 2, 3].map((i) => tool.run({ profile: 'research', task: 't' }, ctx('main', `d${i}`)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await tool.run({ profile: 'research', task: 't' }, ctx('main', 'd4'))).toMatchObject({ isError: true, content: expect.stringMatching(/^3 sub-agents/) });
    release.shift()!();
    expect(await running[0]).toMatchObject({ content: 'done c1' });
    const next = tool.run({ profile: 'research', task: 't' }, ctx('main', 'd5'));
    await new Promise((resolve) => setImmediate(resolve));
    for (const each of release) each();
    expect((await Promise.all([...running.slice(1), next])).map((output) => output.content)).toEqual(['done c2', 'done c3', 'done c4']);
  });

  it('refuses in a child session and for a profile without tools', async () => {
    const { db, tool, ctx } = setup(() => {
      throw new Error('no child may start');
    });
    expect(await tool.run({ profile: 'research', task: 't' }, ctx('sub:research:x'))).toEqual({ isError: true, content: 'A sub-agent cannot start another sub-agent.' });
    expect(await tool.run({ profile: 'browser', task: 't' }, ctx())).toMatchObject({ isError: true, content: expect.stringMatching(/no tools in this app yet/) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_runs').get()).toEqual({ n: 0 });
  });

  it('reports the last text and the outcome of each tool call of a child that stopped', async () => {
    const { db, tool, ctx } = setup(async (input) => {
      const runId = input.runId!;
      db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'subagent', 'main', 'failed', 'x')").run(runId, input.sessionKey);
      const row = db.prepare(
        "INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel) VALUES (?, ?, ?, '{}', '{}', ?, 1, 'x', 'read')",
      );
      row.run(runId, 'k1', 'memory_search', 0);
      row.run(runId, 'k2', 'memory_get', 1);
      appendEvent(db, { sessionKey: input.sessionKey, runId, type: 'assistant_message', payload: { provider: 'fake', model: 'm', content: [], text: 'Two of five notes read.', toolCalls: [], stopReason: 'tool_use' } }, clock());
      return { runId, status: 'failed', text: '', error: 'the task stopped after 20 model calls without a final answer', stoppedAtLimit: true };
    });
    expect(await tool.run({ profile: 'research', task: 't' }, ctx())).toEqual({
      isError: true,
      content:
        'The research sub-agent (run c1) stopped before it finished: the task stopped after 20 model calls without a final answer.\n' +
        'Its last text:\nTwo of five notes read.\nIts tool calls: memory_search (ran), memory_get (failed).',
    });
  });
});
