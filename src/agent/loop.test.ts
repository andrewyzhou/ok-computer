import { describe, expect, it } from 'vitest';
import { createHarness } from '../../test/harness.js';
import { getRunDetail } from '../dashboard/queries.js';
import { textStep, toolStep } from '../models/fake.js';
import { ModelError } from '../models/types.js';

describe('agent loop', () => {
  it('answers a message and records the run, the events and the model call', async () => {
    const { run, rows, events, model } = createHarness([textStep('hello owner')]);
    const result = await run('hi');
    expect(result).toEqual({ runId: 'run-1', status: 'completed', text: 'hello owner' });
    expect(events().map((e) => [e.type, e.runId])).toEqual([
      ['user_message', 'run-1'],
      ['context', 'run-1'],
      ['assistant_message', 'run-1'],
    ]);
    expect(rows('SELECT status, trigger, slot, endedAt IS NOT NULL AS ended FROM runs')).toEqual([
      { status: 'completed', trigger: 'message', slot: 'main', ended: 1 },
    ]);
    expect(rows('SELECT runId, model, costUsd FROM model_calls')).toEqual([
      { runId: 'run-1', model: 'test-model', costUsd: 0.00015 },
    ]);
    expect(model.calls[0]?.system).toBe('stable system prompt');
    expect(model.calls[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: '<context>\ncurrent time: Monday, October 12, 2026 at 20:15 PDT\nchannel: cli\n</context>' },
    ]);
  });

  it('runs tools and returns all results of one turn in one message', async () => {
    const { run, rows, model } = createHarness([
      toolStep({ id: 't1', name: 'now', input: {} }, { id: 't2', name: 'fail', input: {} }),
      textStep('done'),
    ]);
    const result = await run('time?');
    expect(result.status).toBe('completed');
    const second = model.calls[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[2]?.content).toEqual([
      { type: 'tool_result', toolCallId: 't1', content: expect.stringContaining('PDT'), isError: false },
      { type: 'tool_result', toolCallId: 't2', content: 'fail failed: it broke', isError: true },
    ]);
    expect(JSON.stringify(second.messages.slice(0, 1))).toBe(JSON.stringify(model.calls[0]?.messages));
    expect(rows('SELECT toolCallId, name, isError FROM tool_calls ORDER BY id')).toEqual([
      { toolCallId: 't1', name: 'now', isError: 0 },
      { toolCallId: 't2', name: 'fail', isError: 1 },
    ]);
  });

  it('stops at the iteration limit and leaves a note', async () => {
    let n = 0;
    const loop = () => toolStep({ id: `t${++n}`, name: 'now', input: {} });
    const { run, events, model } = createHarness([loop(), loop(), loop()], { maxIterations: 3 });
    const result = await run('loop forever');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('stopped after 3 model calls');
    expect(result.stoppedAtLimit).toBe(true);
    expect(model.calls).toHaveLength(3);
    expect(events().at(-1)?.type).toBe('note');
  });

  it('gives an error result to tool calls in a reply that was cut off', async () => {
    const { db, run, rows, model } = createHarness([
      { toolCalls: [{ id: 't1', name: 'now', input: {} }], stopReason: 'max_tokens' },
      textStep('ok'),
    ]);
    await run('go');
    expect(model.calls[1]?.messages[2]?.content).toEqual([
      { type: 'tool_result', toolCallId: 't1', content: expect.stringContaining('not run'), isError: true },
    ]);
    // the call never reached the policy, but it has a row, so the run timeline shows it.
    expect(rows('SELECT runId, toolCallId, isError, policyDecisionId, output FROM tool_calls')).toEqual([
      {
        runId: 'run-1',
        toolCallId: 't1',
        isError: 1,
        policyDecisionId: null,
        output: JSON.stringify({ content: 'this tool call was not run because the reply was cut off', isError: true }),
      },
    ]);
    const timeline = getRunDetail(db, 'run-1')!.timeline;
    expect(timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call])).map((call) => call.toolCallId)).toEqual(['t1']);
  });

  it('fails the run when the model chain fails', async () => {
    const { run, rows } = createHarness([new ModelError('request', 'bad request', 400)]);
    const result = await run('hi');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('bad request');
    expect(rows('SELECT status FROM runs')).toEqual([{ status: 'failed' }]);
  });

  it('aborts the run when the outer signal fires', async () => {
    const controller = new AbortController();
    const { run } = createHarness([
      async () => {
        controller.abort();
        throw new ModelError('aborted', 'aborted');
      },
    ]);
    const result = await run('hi', { signal: controller.signal });
    expect(result).toMatchObject({ status: 'aborted', error: 'the run was aborted' });
  });

  it('aborts the run at the timeout', async () => {
    const { run } = createHarness(
      [
        (_call, signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new ModelError('aborted', 'aborted'))),
          ),
      ],
      { chatTimeoutMs: 1 },
    );
    expect(await run('hi')).toMatchObject({ status: 'aborted', error: 'the run timed out' });
  });
});
