import { z } from 'zod';
import type { SlotRunner } from '../models/slots.js';
import type { ToolSpec } from '../models/types.js';
import type { Logger } from '../observability/logger.js';
import { wrapUntrusted } from '../tools/untrusted.js';

// extractItems asks a model for facts about a batch of mails: one tool call that gives a list of items. the mails are
// untrusted text, so the request wraps them, and the answer can carry only the fields of the schema for the ids of
// the batch. injected text can at worst give wrong facts for the mails of its batch. it cannot add a tool call, a
// recipient or an action, because the code that uses the facts decides what to do with them, and each action that
// changes mail or the calendar needs the owner's approval.
// the request names the tool in the system text and does not force tool_choice, as the signal classifier does.

export interface ExtractInput {
  id: number;
  text: string;
}

export interface ExtractRequest<T> {
  slot: 'utility' | 'batch';
  // the run of the job. the model call is part of its trace and its cost.
  runId: string;
  system: string;
  tool: ToolSpec;
  // the schema of one item. each item has the id of its input. an item in a bad shape is dropped alone.
  item: z.ZodType<T & { id: number }>;
  inputs: readonly ExtractInput[];
  // the source name of the wrapper, for example "gmail:personal".
  source: string;
  signal?: AbortSignal;
  logger: Logger;
}

export interface Extracted<T> {
  // the items by input id. a model can give more than one item for an input, for example two deadlines in one mail.
  items: Map<number, T[]>;
  modelCallId: number | null;
  // the error of a failed call. aborted is a stop of the app, which says nothing about the inputs.
  error?: string;
  aborted?: boolean;
}

// the most items that one input can give. a mail that asks for a hundred deadlines gets a few.
const PER_INPUT = 5;

export async function extractItems<T>(slots: SlotRunner, request: ExtractRequest<T>): Promise<Extracted<T>> {
  const ids = new Set(request.inputs.map((each) => each.id));
  const items = new Map<number, T[]>();
  if (!ids.size) return { items, modelCallId: null };
  const text = wrapUntrusted(request.source, request.inputs.map((each) => `item ${each.id}:\n${each.text}`).join('\n\n'));
  const result = await slots.call(
    request.slot,
    { system: request.system, messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [request.tool] },
    { runId: request.runId, ...(request.signal ? { signal: request.signal } : {}) },
  );
  if (!result.ok) {
    request.logger.warn('the inbox extraction call failed', { tool: request.tool.name, error: result.error });
    return { items, modelCallId: null, error: result.error, ...(result.aborted ? { aborted: true } : {}) };
  }
  for (const call of result.response.toolCalls.filter((each) => each.name === request.tool.name)) {
    const list = (call.input as { items?: unknown } | null)?.items;
    for (const raw of Array.isArray(list) ? list : []) {
      const parsed = request.item.safeParse(raw);
      if (!parsed.success) {
        // the item holds text from mail, so the log names only its id and the fields that were wrong.
        const id = (raw as { id?: unknown } | null)?.id;
        request.logger.warn('the inbox extraction gave an item in a bad shape', {
          tool: request.tool.name,
          id: typeof id === 'number' ? id : null,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        });
        continue;
      }
      // an id outside the batch is dropped, so the model cannot add facts about a mail that it did not see.
      if (!ids.has(parsed.data.id)) continue;
      const list = items.get(parsed.data.id) ?? [];
      if (list.length < PER_INPUT) list.push(parsed.data);
      items.set(parsed.data.id, list);
    }
  }
  return { items, modelCallId: result.modelCallId };
}

// a tool spec whose input is { items: [...] } with the given item properties. id is added and required.
export function itemsTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'integer' }, ...properties }, required: ['id', ...required] },
        },
      },
      required: ['items'],
    },
  };
}
