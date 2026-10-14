import { randomUUID } from 'node:crypto';
import type { Config, Slot } from '../config/schema.js';
import type { CompactionHooks, ContextStrategy } from '../context/strategy.js';
import type { Db } from '../db/index.js';
import { appendEvent, listEvents, type EventInput } from '../events/log.js';
import type { SlotRunner } from '../models/slots.js';
import type { Logger } from '../observability/logger.js';
import { redact } from '../observability/redact.js';
import type { Clock } from '../time.js';
import type { ToolCaller } from '../tools/caller.js';
import { TOOL_CALL, type ToolRegistry } from '../tools/registry.js';
import { repairSession } from './recovery.js';
import { buildVolatilePrompt } from './system-prompt.js';

export type Trigger = 'message' | 'automation' | 'heartbeat' | 'consolidation' | 'system' | 'subagent';
export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface AgentDeps {
  db: Db;
  slots: SlotRunner;
  tools: ToolRegistry;
  caller: ToolCaller;
  strategy: ContextStrategy;
  logger: Logger;
  config: Pick<Config, 'timeZone' | 'agent'>;
  stablePrompt: (sessionKey: string) => string;
  // extra lines for the volatile context, for example today's goals and the next automations.
  contextLines?: (now: Date) => string;
  clock: Clock;
  newId?: () => string;
  // the ids of the runs that run now in this process. the stale sweep must not close them.
  activeRuns?: Set<string>;
}

export interface RunInput {
  // a caller gives the run id when the session key must contain it.
  runId?: string;
  sessionKey: string;
  trigger: Trigger;
  slot: Slot;
  channel: string;
  allowedTools: readonly string[];
  // events that start the run, for example the owner's message. they get the run id.
  events: EventInput[];
  signal?: AbortSignal;
  // the memory flush before a compaction runs with this flag, so it cannot start a second compaction.
  noCompaction?: boolean;
  // onText gets the text of the current model call while it streams. a channel shows it as a draft.
  onText?: (text: string) => void;
  // onActivity gets the names of the tools that run now, and undefined when they end. a channel shows them.
  onActivity?: (tools: string | undefined) => void;
  // a sub-agent profile sets its own limit of model calls.
  maxIterations?: number;
  // the guard gives the final text that goes to the owner's chat. it runs before the run ends, so a crash during its
  // review leaves a run that the sweep closes, and not a completed run whose reply never came to the chat.
  guardReply?: (text: string, run: { runId: string; signal: AbortSignal }) => Promise<string>;
}

export interface RunResult {
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  text: string;
  error?: string;
  // the run used all its model calls without a final answer.
  stoppedAtLimit?: true;
  // the provider rejected a request of the run, for example with its content filter.
  rejected?: true;
}

export async function runAgent(deps: AgentDeps, input: RunInput): Promise<RunResult> {
  const { db, slots, tools, strategy, config, clock } = deps;
  const runId = input.runId ?? (deps.newId ?? randomUUID)();
  const logger = deps.logger.child({ runId, sessionKey: input.sessionKey });
  const maxIterations = input.maxIterations ?? config.agent.maxIterations;
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
  deps.activeRuns?.add(runId);

  const abort = new AbortController();
  // the time of a compaction does not count against the run. a compaction is a flush turn and up to three summary
  // calls, and under the chat timeout it could use the time of the reply. it has the background timeout of its own.
  let remainingMs = timeoutMs;
  let timerStarted = Date.now();
  let timer = setTimeout(() => abort.abort(new Error('timeout')), remainingMs);
  const pauseTimer = () => {
    clearTimeout(timer);
    remainingMs -= Date.now() - timerStarted;
  };
  const resumeTimer = () => {
    timerStarted = Date.now();
    timer = setTimeout(() => abort.abort(new Error('timeout')), Math.max(remainingMs, 0));
  };
  const onOuterAbort = () => abort.abort(input.signal?.reason);
  if (input.signal?.aborted) onOuterAbort();
  input.signal?.addEventListener('abort', onOuterAbort);

  // the error goes to the trace and to the owner's chat, and the text of an error can hold a secret.
  const finish = (status: RunResult['status'], text: string, raw?: string): RunResult => {
    const error = raw === undefined ? undefined : redact(raw);
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
    // a crash or a failed write can leave a tool call without a result. the provider refuses such a request, so the
    // run first gives each such call a result.
    const repaired = repairSession(db, input.sessionKey, clock, logger);
    if (repaired) logger.warn('gave results to tool calls that had none', { calls: repaired });
    for (const event of input.events) append(event);
    append({
      type: 'context',
      payload: {
        text: buildVolatilePrompt({
          now: clock(),
          timeZone: config.timeZone,
          channel: input.channel,
          // a sub-agent gets only its task. the goals and the automations of the owner are not part of it.
          ...(deps.contextLines && input.trigger !== 'subagent' ? { extra: deps.contextLines(clock()) } : {}),
        }),
      },
    });
    const system = deps.stablePrompt(input.sessionKey);
    const toolSpecs = tools.specs(input.allowedTools);
    const compactionSignal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(config.agent.backgroundTimeoutMs)]);
    const compaction: CompactionHooks | undefined = input.noCompaction
      ? undefined
      : {
          runId,
          signal: abort.signal,
          flush: (text) =>
            runAgent(deps, {
              sessionKey: input.sessionKey,
              trigger: 'system',
              slot: input.slot,
              channel: input.channel,
              allowedTools: input.allowedTools,
              events: [{ type: 'system_event', payload: { text } }],
              signal: abort.signal,
              noCompaction: true,
            }),
        };

    for (let iteration = 1; ; iteration++) {
      if (iteration > maxIterations) {
        const error = `the task stopped after ${maxIterations} model calls without a final answer`;
        append({ type: 'note', payload: { text: error } });
        return { ...finish('failed', '', error), stoppedAtLimit: true };
      }
      pauseTimer();
      const request = await strategy
        .build({
          sessionKey: input.sessionKey,
          events: listEvents(db, input.sessionKey),
          system,
          tools: toolSpecs,
          ...(compaction ? { compaction: { ...compaction, signal: compactionSignal() } } : {}),
        })
        .finally(resumeTimer);
      if (abort.signal.aborted) return finish('aborted', '', abortReason(abort.signal));
      const result = await slots.call(input.slot, request, {
        runId,
        signal: abort.signal,
        ...(input.onText ? { onText: input.onText } : {}),
      });
      if (!result.ok) {
        const ended = finish(result.aborted ? 'aborted' : 'failed', '', abortReason(abort.signal) ?? result.error);
        return result.rejected ? { ...ended, rejected: true } : ended;
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
        const text = input.guardReply ? await input.guardReply(response.text, { runId, signal: abort.signal }) : response.text;
        return finish('completed', text);
      }

      // every tool call gets a result, also when the reply was cut. a call without a result makes the next request fail.
      const callCtx = { runId, sessionKey: input.sessionKey, allowed: input.allowedTools, signal: abort.signal };
      // a tool_call names the integration tool that it calls. the owner knows that name.
      const shown = response.toolCalls.map((call) => {
        const inner = call.name === TOOL_CALL ? (call.input as { name?: unknown }).name : undefined;
        return typeof inner === 'string' ? inner : call.name;
      });
      if (response.stopReason === 'tool_use') input.onActivity?.([...new Set(shown)].join(', '));
      const outputs = await Promise.all(
        response.toolCalls.map((call) =>
          response.stopReason === 'tool_use'
            ? deps.caller.call(call, callCtx)
            : deps.caller.notRun(call, callCtx, 'this tool call was not run because the reply was cut off'),
        ),
      ).finally(() => input.onActivity?.(undefined));
      response.toolCalls.forEach((call, i) => {
        const output = outputs[i]!;
        append({
          type: 'tool_result',
          payload: {
            toolCallId: call.id,
            name: call.name,
            content: output.content,
            isError: output.isError ?? false,
            ...(output.untrustedSource ? { untrustedSource: output.untrustedSource } : {}),
          },
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
    deps.activeRuns?.delete(runId);
  }
}

function abortReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.message === 'timeout' ? 'the run timed out' : 'the run was aborted';
}
