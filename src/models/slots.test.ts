import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import { openDb } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { costUsd } from './cost.js';
import { createFakeClient, textStep, type FakeStep } from './fake.js';
import { createSlotRunner } from './slots.js';
import { ModelError, type ModelRequest } from './types.js';

const request: ModelRequest = { system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

function setup(chain: string[], steps: Record<string, FakeStep[]>) {
  const parsed = parseConfig({ slots: { main: { chain, effort: 'low' } } });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = openDb(':memory:');
  const clients = Object.fromEntries(Object.entries(steps).map(([provider, s]) => [provider, createFakeClient(s, provider)]));
  const sleep = vi.fn(async () => {});
  const runner = createSlotRunner({ db, config: parsed.value, clients, logger: silentLogger, sleep });
  const rows = () =>
    db.prepare('SELECT provider, model, costUsd, stopReason, error FROM model_calls ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
  return { runner, clients, sleep, rows };
}

const transient = () => new ModelError('transient', 'overloaded', 529);

describe('slot runner', () => {
  it('records each call with its cost', async () => {
    const { runner, clients, rows } = setup(['anthropic/claude-haiku-5-5'], {
      anthropic: [{ text: 'hello', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    });
    const result = await runner.call('main', request, { runId: null });
    expect(result.ok && result.response.text).toBe('hello');
    expect(clients.anthropic?.calls[0]).toMatchObject({ model: 'claude-haiku-5-5', maxTokens: 16000, effort: 'low' });
    expect(rows()).toEqual([
      { provider: 'anthropic', model: 'claude-haiku-5-5', costUsd: 0.00015, stopReason: 'end_turn', error: null },
    ]);
  });

  it('retries the same model one time after a transient error', async () => {
    const { runner, sleep, rows } = setup(['anthropic/a', 'anthropic/b'], { anthropic: [transient(), textStep('ok')] });
    const result = await runner.call('main', request, { runId: null });
    expect(result.ok && result.model).toBe('a');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(rows().map((r) => r.error)).toEqual(['overloaded', null]);
  });

  it('moves to the next model after two transient errors', async () => {
    const { runner } = setup(['anthropic/a', 'anthropic/b'], { anthropic: [transient(), transient(), textStep('ok')] });
    const result = await runner.call('main', request, { runId: null });
    expect(result.ok && result.model).toBe('b');
  });

  it('stops the chain on a request error', async () => {
    const { runner, rows } = setup(['anthropic/a', 'anthropic/b'], {
      anthropic: [new ModelError('request', 'bad field', 400), textStep('never')],
    });
    const result = await runner.call('main', request, { runId: null });
    expect(result).toMatchObject({ ok: false, aborted: false });
    expect(rows()).toHaveLength(1);
  });

  it('moves to the next model after a refusal', async () => {
    const { runner, rows } = setup(['anthropic/a', 'other/b'], {
      anthropic: [{ stopReason: 'refusal' }],
      other: [textStep('ok')],
    });
    const result = await runner.call('main', request, { runId: null });
    expect(result.ok && result.provider).toBe('other');
    expect(rows().map((r) => r.stopReason)).toEqual(['refusal', 'end_turn']);
  });

  it('fails when every model refuses', async () => {
    const { runner } = setup(['anthropic/a'], { anthropic: [{ stopReason: 'refusal' }] });
    expect(await runner.call('main', request, { runId: null })).toMatchObject({ ok: false, error: 'anthropic/a refused the request' });
  });

  it('stores a null cost for a model without a price', async () => {
    const { runner, rows } = setup(['local/llama'], { local: [textStep('ok')] });
    await runner.call('main', request, { runId: null });
    expect(rows()[0]?.costUsd).toBeNull();
  });

  it('reports an aborted call', async () => {
    const { runner } = setup(['anthropic/a'], { anthropic: [new ModelError('aborted', 'aborted')] });
    expect(await runner.call('main', request, { runId: null })).toMatchObject({ ok: false, aborted: true });
  });
});

describe('costUsd', () => {
  it('prices every token kind', () => {
    const pricing = { 'p/m': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 } };
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costUsd(pricing, 'p/m', usage)).toBeCloseTo(14.7);
    expect(costUsd(pricing, 'p/unknown', usage)).toBeNull();
  });
});
