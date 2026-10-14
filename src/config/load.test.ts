import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadSecrets, parseConfig } from './load.js';
import { durationMs } from './schema.js';

describe('parseConfig', () => {
  it('fills every field with a default', () => {
    const result = parseConfig({});
    if (!result.ok) throw new Error(result.error);
    const config = result.value;
    expect(config.timeZone).toBe('America/Los_Angeles');
    expect(config.slots.main.chain).toEqual(['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5']);
    expect(config.slots.heartbeat.chain).toEqual(['anthropic/claude-haiku-5-5']);
    expect(config.slots.main.maxTokens).toBe(16000);
    expect(config.agent.maxIterations).toBe(20);
    expect(config.paths.data).toBe('data');
    expect(config.pricing['anthropic/claude-opus-5-5']?.input).toBe(4);
    expect(config.heartbeat).toEqual({ every: '30m', activeHours: { start: '08:00', end: '23:00' } });
    expect(config.routine.reminders).toEqual(['20:00', '21:00', '22:00']);
    expect(config.scheduler.missedGraceMs).toBe(2 * 60 * 60_000);
  });

  it('rejects a heartbeat interval that is not minutes or hours', () => {
    const result = parseConfig({ heartbeat: { every: '30s' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"15m"');
  });

  it('converts heartbeat intervals to milliseconds', () => {
    expect(durationMs('15m')).toBe(15 * 60_000);
    expect(durationMs('1h')).toBe(60 * 60_000);
    expect(durationMs('0')).toBe(0);
  });

  it('keeps the defaults of slots that the file does not set', () => {
    const result = parseConfig({ slots: { main: { chain: ['openai-compat/llama3'] } } });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.slots.main.chain).toEqual(['openai-compat/llama3']);
    expect(result.value.slots.utility.chain).toEqual(['anthropic/claude-haiku-5-5']);
  });

  it('merges custom prices over the default prices', () => {
    const price = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
    const result = parseConfig({ pricing: { 'openai-compat/llama3': price } });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.pricing['openai-compat/llama3']).toEqual(price);
    expect(result.value.pricing['anthropic/claude-haiku-5-5']).toBeDefined();
  });

  it('rejects an unknown time zone with a clear message', () => {
    const result = parseConfig({ timeZone: 'Mars/Olympus' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown time zone');
  });

  // node sets a longer timer to 1 ms, so each run stopped at once while its tools went on to run.
  it('rejects a run timeout over the limit of a node timer', () => {
    expect(parseConfig({ agent: { chatTimeoutMs: 2_147_483_647 } }).ok).toBe(true);
    for (const agent of [{ chatTimeoutMs: 3e9 }, { backgroundTimeoutMs: 2_147_483_648 }]) {
      const result = parseConfig({ agent });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('the limit of a node timer');
    }
  });

  // a typo such as "heartbeet" or "efort" was dropped without a word, and the owner thought the setting worked.
  it('rejects an unknown key at any level, with its name', () => {
    for (const raw of [{ heartbeet: {} }, { heartbeat: { evry: '1h' } }, { slots: { main: { efort: 'high' } } }]) {
      const result = parseConfig(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/heartbeet|evry|efort/);
    }
  });

  // a slot needed its full chain, so { "effort": "high" } alone was refused.
  it('keeps the default chain of a slot that the file changes in part', () => {
    const result = parseConfig({ slots: { main: { effort: 'high' } } });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.slots.main).toMatchObject({ chain: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'], effort: 'high', cacheTtl: '1h' });
    // a slot with its own chain gets no default effort, which an older model can refuse.
    const own = parseConfig({ slots: { heartbeat: { chain: ['anthropic/claude-haiku-4-5'] } } });
    if (!own.ok) throw new Error(own.error);
    expect(own.value.slots.heartbeat).toEqual({ chain: ['anthropic/claude-haiku-4-5'], maxTokens: 16000, cacheTtl: '5m' });
  });

  it('rejects a model reference without a provider', () => {
    const result = parseConfig({ slots: { main: { chain: ['claude-haiku-5-5'] } } });
    expect(result.ok).toBe(false);
  });
});

describe('loadConfig', () => {
  it('uses the defaults when the file does not exist', () => {
    const result = loadConfig(join(tmpdir(), 'okc-missing-config.json'));
    expect(result.ok).toBe(true);
  });

  it('reports a file that is not valid json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'okc-config-'));
    const file = join(dir, 'okc.config.json');
    writeFileSync(file, '{ not json');
    const result = loadConfig(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid json');
  });
});

describe('loadSecrets', () => {
  it('accepts CLAUDE_API_KEY first and ANTHROPIC_API_KEY second', () => {
    expect(loadSecrets({ CLAUDE_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }).anthropicApiKey).toBe('a');
    expect(loadSecrets({ ANTHROPIC_API_KEY: 'b' }).anthropicApiKey).toBe('b');
    expect(loadSecrets({}).anthropicApiKey).toBeUndefined();
  });
});
