import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadSecrets, parseConfig } from './load.js';

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
