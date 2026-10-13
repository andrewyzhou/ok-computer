import type { Result, Secrets } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { ANTHROPIC, createAnthropicClient } from './anthropic.js';
import { createOpenAiCompatClient, OPENAI_COMPAT } from './openai-compat.js';
import { splitModelRef } from './slots.js';
import type { ModelClient } from './types.js';

// the process builds a client only for a provider that a slot uses. a missing credential stops the start.
export function createClients(config: Pick<Config, 'slots'>, secrets: Secrets): Result<Record<string, ModelClient>> {
  const providers = new Set(Object.values(config.slots).flatMap((slot) => slot.chain.map((ref) => splitModelRef(ref).provider)));
  const clients: Record<string, ModelClient> = {};
  for (const provider of providers) {
    if (provider === ANTHROPIC) {
      if (!secrets.anthropicApiKey) return { ok: false, error: 'a slot uses anthropic, but CLAUDE_API_KEY is not set' };
      clients[provider] = createAnthropicClient(secrets.anthropicApiKey);
    } else if (provider === OPENAI_COMPAT) {
      if (!secrets.openaiCompatBaseUrl) {
        return { ok: false, error: 'a slot uses openai-compat, but OPENAI_COMPAT_BASE_URL is not set' };
      }
      clients[provider] = createOpenAiCompatClient(secrets.openaiCompatBaseUrl, secrets.openaiCompatApiKey);
    } else {
      return { ok: false, error: `unknown model provider "${provider}"; use anthropic or openai-compat` };
    }
  }
  return { ok: true, value: clients };
}
