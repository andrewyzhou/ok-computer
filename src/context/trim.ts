import type { StoredEvent } from '../events/log.js';
import { headOf, tailOf } from '../text.js';
import { handleIn } from '../tools/results.js';

export const KEEP_TURNS = 3;
export const CUT_OVER = 4000;
export const CUT_KEEP = 1500;
export const CLEARED = '[old tool result cleared]';

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

// the events of the last KEEP_TURNS assistant turns stay as they are. older tool results are cut, or cleared when
// clear is true. the function returns copies, so the stored events do not change.
export function trimToolResults(events: StoredEvent[], clear: boolean): StoredEvent[] {
  const turns = events.flatMap((event, i) => (event.type === 'assistant_message' ? [i] : []));
  const untouchedFrom = turns.length >= KEEP_TURNS ? turns[turns.length - KEEP_TURNS]! : 0;
  return events.map((event, i) => {
    if (i >= untouchedFrom || event.type !== 'tool_result') return event;
    const content = clear ? cleared(event.payload.content) : cut(event.payload.content);
    return content === event.payload.content ? event : { ...event, payload: { ...event.payload, content } };
  });
}

// a cleared result keeps its handle, so the model can read the full result again with result_read.
function cleared(content: string): string {
  const handle = handleIn(content);
  return handle ? `${CLEARED} the full result is ${handle}.` : CLEARED;
}

function cut(content: string): string {
  if (content.length <= CUT_OVER) return content;
  const head = headOf(content, CUT_KEEP);
  const tail = tailOf(content, CUT_KEEP);
  return `${head}\n[... ${content.length - head.length - tail.length} characters cut ...]\n${tail}`;
}

// a thinking block is bound to the full conversation that produced it. after a compaction that conversation is
// gone, so the kept turns go back without their thinking blocks.
export function stripThinking(event: StoredEvent): StoredEvent {
  if (event.type !== 'assistant_message') return event;
  const content = event.payload.content.filter(
    (block) => !THINKING_TYPES.has(String((block as { type?: unknown }).type)),
  );
  return content.length === event.payload.content.length ? event : { ...event, payload: { ...event.payload, content } };
}
