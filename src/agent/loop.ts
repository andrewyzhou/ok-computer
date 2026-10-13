import { randomUUID } from 'node:crypto';
import type { Config, Slot } from '../config/schema.js';
import type { ContextStrategy } from '../context/strategy.js';
import type { Db } from '../db/index.js';
import { appendEvent, listEvents, type EventInput } from '../events/log.js';
import type { SlotRunner } from '../models/slots.js';
import type { ToolCall } from '../models/types.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { Clock } from '../time.js';
import type { ToolOutput, ToolRegistry } from '../tools/registry.js';
import { buildVolatilePrompt } from './system-prompt.js';

export type Trigger = 'message' | 'automation' | 'heartbeat' | 'consolidation' | 'system';
export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface AgentDeps {
  db: Db;
  slots: SlotRunner;
  tools: ToolRegistry;
  strategy: ContextStrategy;
  logger: Logger;
  config: Pick<Config, 'timeZone' | 'agent'>;
  stablePrompt: (sessionKey: string) => string;
  clock: Clock;
  newId?: () => string;
}

export interface RunInput {
  sessionKey: string;
  trigger: Trigger;
  slot: Slot;
  channel: string;
  allowedTools: readonly string[];
  // events that start the run, for example the owner's message. they get the run id.
  events: EventInput[];
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  text: string;
  error?: string;
}

export async function runAgent(deps: AgentDeps, input: RunInput): Promise<RunResult> {
  const { db, slots, tools, strategy, config, clock } = deps;
  const runId = (deps.newId ?? randomUUID)();
  const logger = deps.logger.child({ runId, sessionKey: input.sessionKey });
  const timeoutMs = input.trigger === 'message' ? config.agent.chatTimeoutMs : config.agent.backgroundTimeoutMs;

  db.prepare('INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    runId,
    input.sessionKey,
    input.trigger,
    input.slot,
    'running',
    clock().toISOString(),
  );
  logger.info('run started', { trigger: input.trigger, slot: input.slot });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);
  const onOuterAbort = () => abort.abort(input.signal?.reason);
  if (input.signal?.aborted) onOuterAbort();
  input.signal?.addEventListener('abort', onOuterAbort);

  const finish = (status: RunResult['status'], text: string, error?: string): RunResult => {
    db.prepare('UPDATE runs SET status = ?, endedAt = ?, error = ? WHERE id = ?').run(
      status,
      clock().toISOString(),
      error ?? null,
      runId,
    );
    logger.info('run ended', { status, error });
    return { runId, status, text, ...(error ? { error } : {}) };
  };
  const append = (event: EventInput) => appendEvent(db, { ...event, sessionKey: input.sessionKey, runId }, clock());

  try {
    for (const event of input.events) append(event);
    append({
      type: 'context',
      payload: { text: buildVolatilePrompt({ now: clock(), timeZone: config.timeZone, channel: input.channel }) },
    });
    const system = deps.stablePrompt(input.sessionKey);
    const toolSpecs = tools.specs(input.allowedTools);

    for (let iteration = 1; ; iteration++) {
      if (iteration > config.agent.maxIterations) {
        const error = `the task stopped after ${config.agent.maxIterations} model calls without a final answer`;
        append({ type: 'note', payload: { text: error } });
        return finish('failed', '', error);
      }
      const request = await strategy.build({
        sessionKey: input.sessionKey,
        events: listEvents(db, input.sessionKey),
        system,
        tools: toolSpecs,
      });
      const result = await slots.call(input.slot, request, { runId, signal: abort.signal });
      if (!result.ok) {
        return finish(result.aborted ? 'aborted' : 'failed', '', abortReason(abort.signal) ?? result.error);
      }
      const response = result.response;
      append({
        type: 'assistant_message',
        payload: {
          provider: result.provider,
          model: result.model,
          content: response.content,
          text: response.text,
          toolCalls: response.toolCalls,
          stopReason: response.stopReason,
        },
      });
      if (!response.toolCalls.length) {
        if (response.stopReason === 'max_tokens') logger.warn('reply was cut at the token limit');
        return finish('completed', response.text);
      }

      // every tool call gets a result, also when the reply was cut. a call without a result makes the next request fail.
      const outputs = await Promise.all(
        response.toolCalls.map((call) =>
          response.stopReason === 'tool_use'
            ? runTool(deps, call, input, runId, abort.signal)
            : Promise.resolve({ content: 'this tool call was not run because the reply was cut off', isError: true }),
        ),
      );
      response.toolCalls.forEach((call, i) => {
        const output = outputs[i]!;
        append({
          type: 'tool_result',
          payload: { toolCallId: call.id, name: call.name, content: output.content, isError: output.isError ?? false },
        });
      });
      if (abort.signal.aborted) return finish('aborted', '', abortReason(abort.signal));
    }
  } catch (err) {
    logger.error('run crashed', { err });
    return finish('failed', '', (err as Error).message);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}

async function runTool(
  deps: AgentDeps,
  call: ToolCall,
  input: RunInput,
  runId: string,
  signal: AbortSignal,
): Promise<ToolOutput> {
  const started = performance.now();
  const ctx = { runId, sessionKey: input.sessionKey, timeZone: deps.config.timeZone, clock: deps.clock, signal };
  const output = await deps.tools.run(call, input.allowedTools, ctx);
  deps.db
    .prepare(
      `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      call.id,
      call.name,
      redactedJson(call.input),
      redactedJson(output),
      output.isError ? 1 : 0,
      Math.round(performance.now() - started),
      deps.clock().toISOString(),
    );
  return output;
}

function abortReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.message === 'timeout' ? 'the run timed out' : 'the run was aborted';
}
