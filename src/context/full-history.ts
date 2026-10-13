import type { StoredEvent } from '../events/log.js';
import type { ModelMessage, UserBlock } from '../models/types.js';
import type { ContextStrategy } from './strategy.js';

// this strategy renders every event after the last session reset. the output for old events never changes, so
// each request repeats the previous request as an exact prefix.
export const fullHistory: ContextStrategy = {
  name: 'full-history',
  async build({ events, system, tools }) {
    return { system, tools, messages: renderEvents(sinceLastReset(events)) };
  },
};

export function sinceLastReset(events: StoredEvent[]): StoredEvent[] {
  const reset = events.findLastIndex((event) => event.type === 'session_reset');
  return events.slice(reset + 1);
}

// consecutive user-side events become one user message. all tool results of one assistant turn then go back in
// one message, which the providers require.
export function renderEvents(events: StoredEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const pushUser = (block: UserBlock) => {
    const last = messages.at(-1);
    if (last?.role === 'user') last.content.push(block);
    else messages.push({ role: 'user', content: [block] });
  };
  for (const event of events) {
    switch (event.type) {
      case 'user_message':
        pushUser({ type: 'text', text: event.payload.text });
        break;
      case 'context':
        pushUser({ type: 'text', text: event.payload.text });
        break;
      case 'note':
        pushUser({ type: 'text', text: `<note>\n${event.payload.text}\n</note>` });
        break;
      case 'system_event':
        pushUser({ type: 'text', text: `<system_event>\n${event.payload.text}\n</system_event>` });
        break;
      case 'tool_result':
        pushUser({
          type: 'tool_result',
          toolCallId: event.payload.toolCallId,
          content: event.payload.content,
          isError: event.payload.isError,
        });
        break;
      case 'assistant_message':
        messages.push({ role: 'assistant', ...event.payload });
        break;
      case 'compaction':
      case 'session_reset':
        break;
    }
  }
  return messages;
}
