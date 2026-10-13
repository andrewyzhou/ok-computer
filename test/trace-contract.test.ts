import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { textStep, toolStep } from '../src/models/fake.js';
import { defineTool } from '../src/tools/registry.js';
import { createHarness, danglingToolCalls } from './harness.js';

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
