import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import { createClients } from './clients.js';

function config(chain: string[]) {
  const parsed = parseConfig({
    slots: Object.fromEntries(
      ['main', 'heartbeat', 'utility', 'batch', 'consolidation', 'compaction'].map((slot) => [slot, { chain }]),
    ),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('createClients', () => {
  it('builds only the providers that slots use', () => {
    const result = createClients(config(['anthropic/claude-haiku-5-5']), { anthropicApiKey: 'k' });
    expect(result.ok && Object.keys(result.value)).toEqual(['anthropic']);
  });

  it('stops when a used provider has no credentials', () => {
    expect(createClients(config(['anthropic/claude-haiku-5-5']), {})).toMatchObject({ ok: false });
    expect(createClients(config(['openai-compat/llama3']), {})).toMatchObject({ ok: false });
  });

  it('rejects an unknown provider', () => {
    const result = createClients(config(['mystery/model']), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown model provider');
  });
});
