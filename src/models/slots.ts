import type { Config, Slot } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import { costUsd } from './cost.js';
import { ModelError, type ModelCall, type ModelClient, type ModelRequest, type ModelResponse } from './types.js';

export type SlotResult =
  | { ok: true; response: ModelResponse; provider: string; model: string }
  | { ok: false; error: string; aborted: boolean };

export interface SlotRunner {
  call(slot: Slot, request: ModelRequest, context: { runId: string | null; signal?: AbortSignal }): Promise<SlotResult>;
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
    async call(slot, request, { runId, signal }) {
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
        const call: ModelCall = { ...request, model, maxTokens: slotConfig.maxTokens, effort: slotConfig.effort };
        for (let attempt = 0; attempt < 2; attempt++) {
          const started = performance.now();
          try {
            const response = await client.complete(call, signal);
            const cost = costUsd(config.pricing, ref, response.usage);
            record(db, { runId, slot, provider, model, call, response, cost, latencyMs: response.latencyMs }, clock());
            if (response.stopReason === 'refusal') {
              lastError = `${ref} refused the request`;
              logger.warn('model refused, trying the next model', { slot, ref, runId });
              break;
            }
            return { ok: true, response, provider, model };
          } catch (err) {
            if (!(err instanceof ModelError)) throw err;
            const latencyMs = Math.round(performance.now() - started);
            record(db, { runId, slot, provider, model, call, error: err.message, cost: null, latencyMs }, clock());
            if (err.kind === 'aborted') return { ok: false, error: 'the run was aborted', aborted: true };
            if (err.kind === 'request') {
              logger.error('model request failed', { slot, ref, runId, status: err.status, err });
              return { ok: false, error: `${ref} rejected the request: ${err.message}`, aborted: false };
            }
            lastError = `${ref} failed: ${err.message}`;
            logger.warn('transient model error', { slot, ref, runId, attempt, status: err.status, err });
            if (attempt === 0) await sleep(RETRY_DELAY_MS);
          }
        }
      }
      return { ok: false, error: lastError, aborted: false };
    },
  };
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

function record(db: Db, row: CallRecord, now: Date): void {
  const usage = row.response?.usage;
  db.prepare(
    `INSERT INTO model_calls (runId, slot, provider, model, inputTokens, outputTokens, cacheReadTokens,
       cacheWriteTokens, costUsd, latencyMs, stopReason, error, request, response, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}
