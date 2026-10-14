import { createHash } from 'node:crypto';
import type { Config, Slot } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { redact, redactedJson } from '../observability/redact.js';
import { costUsd } from './cost.js';
import {
  ModelError,
  type ModelCall,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ToolSpec,
} from './types.js';

export type SlotResult =
  // modelCallId is the model_calls row of the answer, so a caller can link a label or a verdict to its call.
  | { ok: true; response: ModelResponse; provider: string; model: string; modelCallId: number }
  // rejected is a request error that the input can cause, for example a content filter of the provider.
  | { ok: false; error: string; aborted: boolean; rejected?: true };

export interface SlotRunner {
  call(
    slot: Slot,
    request: ModelRequest,
    context: { runId: string | null; signal?: AbortSignal; onText?: (text: string) => void },
  ): Promise<SlotResult>;
}

export interface SlotRunnerDeps {
  db: Db;
  config: Pick<Config, 'slots' | 'pricing'>;
  clients: Record<string, ModelClient>;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

const RETRY_DELAY_MS = 2000;

export function splitModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

// each model in the chain gets one retry after a transient error. a refusal moves to the next model.
// a request error stops the chain, because the next model gets the same bad request.
export function createSlotRunner(deps: SlotRunnerDeps): SlotRunner {
  const { db, config, clients, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = deps.clock ?? (() => new Date());

  return {
    async call(slot, request, { runId, signal, onText }) {
      const slotConfig = config.slots[slot];
      let lastError = 'the slot chain is empty';
      for (const ref of slotConfig.chain) {
        const { provider, model } = splitModelRef(ref);
        const client = clients[provider];
        if (!client) {
          lastError = `no client is configured for provider ${provider}`;
          logger.warn('model provider missing', { slot, ref });
          continue;
        }
        const call: ModelCall = { ...request, model, maxTokens: slotConfig.maxTokens, effort: slotConfig.effort, cacheTtl: slotConfig.cacheTtl };
        for (let attempt = 0; attempt < 2; attempt++) {
          const started = performance.now();
          // a retry, a refusal or the next model throws the old text away, so the draft of the owner clears too.
          onText?.('');
          try {
            const response = await client.complete(call, signal, onText);
            const cost = costUsd(config.pricing, ref, response.usage);
            const modelCallId = record(db, { runId, slot, provider, model, call, response, cost, latencyMs: response.latencyMs }, clock());
            if (response.warnings) logger.warn('provider changed the input', { slot, ref, runId, warnings: response.warnings });
            if (response.stopReason === 'refusal') {
              lastError = `${ref} refused the request`;
              logger.warn('model refused, trying the next model', { slot, ref, runId });
              break;
            }
            return { ok: true, response, provider, model, modelCallId };
          } catch (err) {
            if (!(err instanceof ModelError)) throw err;
            const latencyMs = Math.round(performance.now() - started);
            // a provider can echo the key in its error body. the text goes to the trace, the run, and the owner's chat.
            const message = redact(err.message);
            // the text of a cut stream reached the owner's draft, and its tokens are billed, so the row keeps them.
            const partial = err.partial;
            const cost = partial ? costUsd(config.pricing, ref, partial.usage) : null;
            record(db, { runId, slot, provider, model, call, error: message, cost, latencyMs, ...(partial ? { response: partial } : {}) }, clock());
            if (err.kind === 'aborted') return { ok: false, error: 'the run was aborted', aborted: true };
            if (err.kind === 'request') {
              logger.error('model request failed', { slot, ref, runId, status: err.status, err });
              return { ok: false, error: `${ref} rejected the request: ${message}`, aborted: false, ...(fromInput(err) ? { rejected: true as const } : {}) };
            }
            lastError = `${ref} failed: ${message}`;
            logger.warn('transient model error', { slot, ref, runId, attempt, status: err.status, err });
            if (attempt === 0) await sleep(RETRY_DELAY_MS);
          }
        }
      }
      return { ok: false, error: lastError, aborted: false };
    },
  };
}

// a request error can come from the text of the input: a content filter, or an input that is too large or not valid.
// a bad key (401, 403), a missing model (404) and an empty credit balance (a 400) come from the setup of the owner, so
// they are like an outage. an error event inside a stream has no status.
function fromInput(err: ModelError): boolean {
  return [undefined, 0, 400, 413, 422].includes(err.status) && !/credit balance|billing|quota/i.test(err.message);
}

interface CallRecord {
  runId: string | null;
  slot: Slot;
  provider: string;
  model: string;
  call: ModelCall;
  response?: ModelResponse;
  error?: string;
  cost: number | null;
  latencyMs: number;
}

// the snapshot keeps each distinct tool list one time. the hash on each call shows which tools the model had. the
// text is redacted the same as the request, because the tool list of an mcp server is text from outside.
export function recordToolCatalog(db: Db, tools: ToolSpec[], now: Date): string {
  const json = redactedJson(tools);
  const hash = createHash('sha256').update(json).digest('hex');
  db.prepare('INSERT OR IGNORE INTO tool_catalog_snapshots (hash, tools, createdAt) VALUES (?, ?, ?)').run(
    hash,
    json,
    now.toISOString(),
  );
  return hash;
}

function record(db: Db, row: CallRecord, now: Date): number {
  const usage = row.response?.usage;
  const result = db.prepare(
    `INSERT INTO model_calls (runId, slot, provider, model, inputTokens, outputTokens, cacheReadTokens,
       cacheWriteTokens, costUsd, latencyMs, stopReason, error, request, response, createdAt, toolCatalogHash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.runId,
    row.slot,
    row.provider,
    row.model,
    usage?.inputTokens ?? 0,
    usage?.outputTokens ?? 0,
    usage?.cacheReadTokens ?? 0,
    usage?.cacheWriteTokens ?? 0,
    row.cost,
    row.latencyMs,
    row.response?.stopReason ?? null,
    row.error ?? null,
    redactedJson(row.call),
    row.response ? redactedJson(row.response) : null,
    now.toISOString(),
    recordToolCatalog(db, row.call.tools, now),
  );
  return Number(result.lastInsertRowid);
}
