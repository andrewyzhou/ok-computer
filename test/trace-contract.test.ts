import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { appendEvent } from '../src/events/log.js';
import { textStep, toolStep } from '../src/models/fake.js';
import { defineTool } from '../src/tools/registry.js';
import { createHarness, createTestCaller, danglingToolCalls } from './harness.js';

// these tests state what a trusted trace needs when something fails: a stuck tool, a failed write, or a crash.

const stuck = (started: () => void = () => {}) =>
  defineTool({
    name: 'stuck',
    description: 'Never ends and ignores the abort signal.',
    input: z.object({}),
    risk: 'read',
    run: () => {
      started();
      return new Promise(() => {});
    },
  });

describe('a failed write and a crash', () => {
  it('keeps the session valid when the trace write fails after the tool ran', async () => {
    // the result is long, so the caller needs a blob for it.
    const long = defineTool({ name: 'long', description: 'Long.', input: z.object({}), risk: 'read', run: async () => ({ content: 'x'.repeat(5000) }) });
    const { run, model, deps, rows } = createHarness([toolStep({ id: 't1', name: 'long', input: {} }), textStep('done'), textStep('second')], {}, { tools: [long] });
    // the disk refuses the blob, for example because a virus scanner holds the file.
    deps.caller = createTestCaller(deps.db, deps.tools, deps.clock, {
      blobs: {
        put: () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        },
        read: () => undefined,
      },
    }).caller;
    expect((await run('read the long thing')).status).toBe('completed');
    expect(rows('SELECT COUNT(*) AS n FROM tool_calls')).toEqual([{ n: 0 }]);
    expect((await run('hello again')).status).toBe('completed');
    expect(danglingToolCalls(model.calls.at(-1)!.messages)).toEqual([]);
  });

  it('repairs a call that the caller left without a result, and puts the result before a later system event', async () => {
    const { db, run, model, deps } = createHarness([toolStep({ id: 't1', name: 'now', input: {} }), textStep('ok')]);
    const real = deps.caller;
    // a bug in the caller: it throws one time. the run fails and leaves the call without a result.
    let thrown = false;
    deps.caller = { ...real, call: (call, ctx) => (thrown ? real.call(call, ctx) : ((thrown = true), Promise.reject(new Error('a bug')))) };
    expect((await run('time?')).status).toBe('failed');
    // the queue runs other work between the runs, for example an automation note for the main session.
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'system_event', payload: { text: 'An automation ran.' } });
    expect((await run('hello')).status).toBe('completed');
    expect(danglingToolCalls(model.calls.at(-1)!.messages)).toEqual([]);
  });

  it('gives the next request after a crash a result for the call that was running', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'okc-crash-')), 'okc.sqlite');
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => (started = resolve));
    const before = createHarness([toolStep({ id: 'h1', name: 'stuck', input: {} })], {}, { tools: [stuck(() => started())], db: openDb(path) });
    void before.run('do the slow thing');
    await toolStarted;
    // the process dies here. a new process opens the same file.
    const after = createHarness([textStep('hello')], {}, { tools: [stuck()], db: openDb(path), idPrefix: 'next' });
    expect((await after.run('are you there')).status).toBe('completed');
    expect(danglingToolCalls(after.model.calls[0]!.messages)).toEqual([]);
    expect(after.rows("SELECT toolCallId, outcome FROM tool_calls")).toEqual([{ toolCallId: 'h1', outcome: 'interrupted' }]);
  });
});

describe('a tool that ignores the abort signal', () => {
  it('does not hold the run after its timeout, and the next run of the session gets a valid request', async () => {
    const { run, model, rows } = createHarness(
      [toolStep({ id: 'h1', name: 'stuck', input: {} }), textStep('hello again')],
      { chatTimeoutMs: 50 },
      { tools: [stuck()] },
    );
    const first = await Promise.race([run('do the slow thing'), new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))]);
    expect(first).toMatchObject({ status: 'aborted', error: 'the run timed out' });
    expect(rows("SELECT toolCallId, outcome FROM tool_calls")).toEqual([{ toolCallId: 'h1', outcome: 'abandoned' }]);
    expect((await run('are you there')).status).toBe('completed');
    expect(danglingToolCalls(model.calls.at(-1)!.messages)).toEqual([]);
  });
});
