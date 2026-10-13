import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { configSchema, DEFAULT_PRICING, type Config } from './schema.js';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// the config file is optional. every field has a default.
export function loadConfig(path = 'okc.config.json'): Result<Config> {
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      return { ok: false, error: `${path} is not valid json: ${(err as Error).message}` };
    }
  }
  return parseConfig(raw, path);
}

export function parseConfig(raw: unknown, source = 'config'): Result<Config> {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `${source} is invalid:\n${z.prettifyError(parsed.error)}` };
  }
  const config = parsed.data;
  config.pricing = { ...DEFAULT_PRICING, ...config.pricing };
  return { ok: true, value: config };
}

export interface Secrets {
  anthropicApiKey?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatApiKey?: string;
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  return {
    anthropicApiKey: env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY || undefined,
    openaiCompatBaseUrl: env.OPENAI_COMPAT_BASE_URL || undefined,
    openaiCompatApiKey: env.OPENAI_COMPAT_API_KEY || undefined,
  };
}

// node reads the .env file itself. a missing file is not an error.
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
