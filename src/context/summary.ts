import type { StoredEvent } from '../events/log.js';
import type { SlotRunner } from '../models/slots.js';
import type { ModelMessage } from '../models/types.js';
import type { Logger } from '../observability/logger.js';

export const SUMMARY_HEADINGS = [
  '## goals and commitments',
  '## decisions',
  '## open requests',
  '## facts and identifiers',
  '## recent progress',
] as const;
export const DROPPED_HEADING = '## dropped identifiers';
export const SUMMARY_ATTEMPTS = 3;
const LISTED_FAILURES = 100;

export const SUMMARY_PROMPT = `You write a summary of the earlier part of a conversation between Computer, a personal assistant, and its owner. The assistant will see only your summary instead of that part, so the summary must keep everything that can matter later.

Use exactly these headings, in this order:
${SUMMARY_HEADINGS.join('\n')}

Under each heading, write short bullets in plain sentences. Under "## facts and identifiers", copy every date, time, number, id, file path, and URL that can matter later, exactly as written. When an identifier no longer matters, list it under a last heading "${DROPPED_HEADING}". Do not add facts that are not in the conversation. Write only the summary.`;

// the transcript is plain text, so any provider can summarize the turns of any other provider.
export function transcript(events: StoredEvent[]): string {
  return events
    .flatMap((event): string[] => {
      switch (event.type) {
        case 'user_message':
          return [`owner: ${event.payload.text}`];
        case 'assistant_message':
          return [
            ...(event.payload.text.trim() ? [`assistant: ${event.payload.text}`] : []),
            ...event.payload.toolCalls.map((call) => `assistant called ${call.name} with ${JSON.stringify(call.input)}`),
          ];
        case 'tool_result':
          return [`${event.payload.isError ? 'error from' : 'result of'} ${event.payload.name}: ${event.payload.content}`];
        case 'system_event':
          return [`system event: ${event.payload.text}`];
        case 'context':
          return [`system context: ${event.payload.text}`];
        case 'note':
          return [`note: ${event.payload.text}`];
        case 'compaction':
        case 'session_reset':
          return [];
      }
    })
    .join('\n\n');
}

// the order matters. each match is removed from the text, so a later pattern does not find a part of it again.
const IDENTIFIER_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s<>"'`)\]}]+[^\s<>"'`)\]}.,;:!?]/g,
  /(?:[\w.-]+[/\\])+[\w-]+\.[a-z0-9]{1,5}\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b(?:[01]\d|2[0-3]):[0-5]\d\b/g,
  /#\d+\b/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/g,
  /\b\d+(?:\.\d+)?\b/g,
];
const ISO_TIMESTAMP = /\b(\d{4}-\d{2}-\d{2})T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?/g;

// context events repeat the clock in each run, so their values are not identifiers of the conversation.
export function findIdentifiers(events: StoredEvent[], previousSummary?: string): string[] {
  const texts = events.flatMap((event): string[] => {
    switch (event.type) {
      case 'user_message':
      case 'system_event':
      case 'note':
        return [event.payload.text];
      case 'assistant_message':
        return [event.payload.text, ...event.payload.toolCalls.map((call) => JSON.stringify(call.input))];
      case 'tool_result':
        return [event.payload.content];
      default:
        return [];
    }
  });
  if (previousSummary) texts.push(previousSummary);

  const found = new Set<string>();
  for (const original of texts) {
    // a full timestamp counts as its date. the summary gives times in the owner's time zone.
    let text = original.replace(ISO_TIMESTAMP, (_match, date: string) => ` ${date} `);
    for (const pattern of IDENTIFIER_PATTERNS) {
      text = text.replace(pattern, (match) => {
        // one digit is too common to check, for example in "1 of 3 goals".
        if (!/^\d$/.test(match)) found.add(match);
        return ' ';
      });
    }
  }
  return [...found];
}

export function validateSummary(summary: string, identifiers: string[]): string[] {
  const failures: string[] = [];
  const lower = summary.toLowerCase();
  const missingHeadings = SUMMARY_HEADINGS.filter((heading) => !summary.split(/\r?\n/).some((line) => line.trim() === heading));
  if (missingHeadings.length) failures.push(`These headings are missing: ${missingHeadings.join(', ')}.`);
  const missing = identifiers.filter((id) => !lower.includes(id.toLowerCase()));
  if (missing.length) {
    const listed = missing.slice(0, LISTED_FAILURES).join(', ');
    const more = missing.length > LISTED_FAILURES ? ` and ${missing.length - LISTED_FAILURES} more` : '';
    failures.push(
      `These identifiers from the conversation are not in the summary: ${listed}${more}. Add each one where it belongs, or list it under ${DROPPED_HEADING}.`,
    );
  }
  return failures;
}

export type SummaryResult = { ok: true; summary: string; model: string } | { ok: false; error: string };

export async function summarize(
  deps: { slots: SlotRunner; logger: Logger },
  input: { runId: string; signal: AbortSignal; events: StoredEvent[]; previousSummary?: string },
): Promise<SummaryResult> {
  const identifiers = findIdentifiers(input.events, input.previousSummary);
  const previous = input.previousSummary ? `<previous_summary>\n${input.previousSummary}\n</previous_summary>\n\n` : '';
  const messages: ModelMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `${previous}<conversation>\n${transcript(input.events)}\n</conversation>` }] },
  ];
  let failures: string[] = [];
  for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt++) {
    const result = await deps.slots.call(
      'compaction',
      { system: SUMMARY_PROMPT, tools: [], messages },
      { runId: input.runId, signal: input.signal },
    );
    if (!result.ok) return { ok: false, error: result.error };
    const summary = result.response.text.trim();
    failures = validateSummary(summary, identifiers);
    if (!failures.length) return { ok: true, summary, model: result.model };
    deps.logger.warn('compaction summary failed validation', { runId: input.runId, attempt, failures });
    // the next attempt sees its earlier summary and the failures, so it can fix only what is wrong.
    messages.push(
      {
        role: 'assistant',
        provider: result.provider,
        model: result.model,
        content: result.response.content,
        text: result.response.text,
        toolCalls: result.response.toolCalls,
        stopReason: result.response.stopReason,
      },
      { role: 'user', content: [{ type: 'text', text: `${failures.join('\n')}\nWrite the full summary again.` }] },
    );
  }
  return { ok: false, error: `the summary failed validation ${SUMMARY_ATTEMPTS} times: ${failures.join(' ')}` };
}
