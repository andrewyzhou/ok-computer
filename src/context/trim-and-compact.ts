import type { Db } from '../db/index.js';
import { appendEvent, listEvents, type EventPayloads, type StoredEvent } from '../events/log.js';
import type { SlotRunner } from '../models/slots.js';
import type { ModelMessage, ModelRequest, ToolSpec } from '../models/types.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { renderEvents, sinceLastReset } from './full-history.js';
import type { CompactionHooks, ContextInput, ContextStrategy } from './strategy.js';
import { summarize } from './summary.js';
import { estimateTokens } from './tokens.js';
import { stripThinking, trimToolResults } from './trim.js';

const RESERVE_TOKENS = 20_000;
const KEEP_TOKENS = 20_000;

export const FLUSH_PROMPT =
  "The conversation is long, and its older part will be replaced by a summary soon. Before that, save the durable facts, preferences, decisions, and open commitments from this conversation that are not saved yet. Use memory_write for today's daily note. Do not answer the owner now. When you are done, reply with exactly NO_REPLY.";
export const FLUSH_DONE = 'The memory flush is done. Continue the conversation from the last message of the owner or the system.';

export interface TrimAndCompactDeps {
  db: Db;
  slots: SlotRunner;
  logger: Logger;
  clock: Clock;
  windowTokens: number;
}

type CompactionEvent = Extract<StoredEvent, { type: 'compaction' }>;

interface View {
  // the events that the model still sees, without compaction events. a summary stands for the older events.
  live: StoredEvent[];
  compaction?: CompactionEvent;
}

function currentView(events: StoredEvent[]): View {
  const segment = sinceLastReset(events);
  const compaction = segment.findLast((event): event is CompactionEvent => event.type === 'compaction');
  const live = segment.filter(
    (event) => event.type !== 'compaction' && (!compaction || event.id >= compaction.payload.firstKeptEventId),
  );
  return compaction ? { live, compaction } : { live };
}

function withSummary(messages: ModelMessage[], summary: string): ModelMessage[] {
  const block = { type: 'text' as const, text: `<summary>\n${summary}\n</summary>` };
  const first = messages[0];
  if (first?.role === 'user') return [{ ...first, content: [block, ...first.content] }, ...messages.slice(1)];
  return [{ role: 'user', content: [block] }, ...messages];
}

// the kept events render the same way on every request until the next compaction. the trim depends only on the
// compaction event, so the prefix stays byte-stable and the prompt cache keeps working.
function renderCompacted(live: StoredEvent[], compaction: CompactionEvent): ModelMessage[] {
  const kept = live.filter((event) => event.id < compaction.id).map(stripThinking);
  const after = live.filter((event) => event.id > compaction.id);
  const events = [...trimToolResults(kept, compaction.payload.clearToolResults), ...after];
  return withSummary(renderEvents(events), compaction.payload.summary);
}

function render(view: View): ModelMessage[] {
  return view.compaction ? renderCompacted(view.live, view.compaction) : renderEvents(view.live);
}

// the kept part must hold the call of each tool result in it, or the request is invalid. a result usually comes just
// after its call, but a repaired result comes after the events that arrived while the process was down, for example
// a system event. so the scan keeps the ids of the results whose call it did not reach yet, and a boundary is valid
// only when that set is empty. the kept part is the longest valid part under keepTokens, or the shortest valid part
// when even that is larger.
export function chooseBoundary(live: StoredEvent[], keepTokens: number): number {
  let tokens = 0;
  let boundary = -1;
  const open = new Set<string>();
  for (let i = live.length - 1; i > 0; i--) {
    const event = live[i]!;
    tokens += estimateTokens(event.payload);
    if (event.type === 'tool_result') open.add(event.payload.toolCallId);
    if (event.type === 'assistant_message') for (const call of event.payload.toolCalls) open.delete(call.id);
    if (event.type === 'tool_result' || open.size) continue;
    if (tokens > keepTokens && boundary !== -1) break;
    boundary = i;
  }
  return boundary;
}

export function createTrimAndCompact(deps: TrimAndCompactDeps): ContextStrategy {
  const { db, logger, clock, windowTokens } = deps;
  const reserve = Math.min(RESERVE_TOKENS, Math.floor(windowTokens / 4));
  const keep = Math.min(KEEP_TOKENS, Math.floor(windowTokens / 4));
  // a run with a failed compaction does not try again. each attempt costs up to three summary calls.
  const failedRuns = new Set<string>();

  const request = (system: string, tools: ToolSpec[], messages: ModelMessage[]): ModelRequest => ({ system, tools, messages });

  // without a compaction the strategy can only trim. this changes old turns, so the api drops the thinking blocks
  // after the first change, and the cache starts again. it is the fallback when a compaction fails.
  const trimmedFallback = (input: ContextInput, events: StoredEvent[]): ModelRequest => {
    const { live, compaction } = currentView(events);
    const draft = (clear: boolean) => {
      const prepared = live.map((event) => (compaction && event.id < compaction.id ? stripThinking(event) : event));
      const messages = renderEvents(trimToolResults(prepared, clear));
      return request(input.system, input.tools, compaction ? withSummary(messages, compaction.payload.summary) : messages);
    };
    const cut = draft(false);
    return estimateTokens(cut) <= windowTokens / 2 ? cut : draft(true);
  };

  const compact = async (input: ContextInput, hooks: CompactionHooks, tokensBefore: number): Promise<boolean> => {
    let events = input.events;
    // the kept events of the last compaction can hold the flush that ran before it. only a newer flush counts.
    const before = currentView(events);
    const flushed = before.live.some(
      (event) =>
        event.type === 'system_event' &&
        event.payload.text === FLUSH_PROMPT &&
        (!before.compaction || event.id > before.compaction.id),
    );
    if (!flushed && input.tools.some((tool) => tool.name === 'memory_write')) {
      const result = await hooks.flush(FLUSH_PROMPT);
      if (result.status !== 'completed') logger.warn('memory flush failed', { runId: hooks.runId, status: result.status });
      else if (result.text.trim() !== 'NO_REPLY') logger.warn('memory flush did not end with NO_REPLY', { runId: hooks.runId });
      // the next model call must start a new user turn. a request that ends with an assistant turn is refused.
      appendEvent(db, { sessionKey: input.sessionKey, runId: hooks.runId, type: 'system_event', payload: { text: FLUSH_DONE } }, clock());
      events = listEvents(db, input.sessionKey);
    }

    const view = currentView(events);
    const boundary = chooseBoundary(view.live, keep);
    if (boundary <= 0) {
      logger.warn('compaction found nothing to summarize', { runId: hooks.runId });
      return false;
    }
    const summary = await summarize(deps, {
      runId: hooks.runId,
      signal: hooks.signal,
      events: view.live.slice(0, boundary),
      ...(view.compaction ? { previousSummary: view.compaction.payload.summary } : {}),
    });
    if (!summary.ok) {
      logger.warn('compaction failed, so the context uses trimming only', { runId: hooks.runId, error: summary.error });
      return false;
    }

    const kept = view.live.slice(boundary).map(stripThinking);
    const draft = (clear: boolean) =>
      request(input.system, input.tools, withSummary(renderEvents(trimToolResults(kept, clear)), summary.summary));
    const clearToolResults = estimateTokens(draft(false)) > windowTokens / 2;
    const payload: EventPayloads['compaction'] = {
      summary: summary.summary,
      firstKeptEventId: view.live[boundary]!.id,
      tokensBefore,
      tokensAfter: estimateTokens(draft(clearToolResults)),
      model: summary.model,
      clearToolResults,
    };
    appendEvent(db, { sessionKey: input.sessionKey, runId: hooks.runId, type: 'compaction', payload }, clock());
    logger.info('session compacted', { runId: hooks.runId, tokensBefore, tokensAfter: payload.tokensAfter });
    return true;
  };

  return {
    name: 'trim-and-compact',
    async build(input) {
      const full = request(input.system, input.tools, render(currentView(input.events)));
      const hooks = input.compaction;
      const tokens = estimateTokens(full);
      if (!hooks || tokens <= windowTokens - reserve) return full;
      if (failedRuns.has(hooks.runId)) return trimmedFallback(input, input.events);
      if (await compact(input, hooks, tokens)) {
        return request(input.system, input.tools, render(currentView(listEvents(db, input.sessionKey))));
      }
      failedRuns.add(hooks.runId);
      return trimmedFallback(input, listEvents(db, input.sessionKey));
    },
  };
}
