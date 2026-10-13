import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import {
  ModelError,
  type ModelCall,
  type ModelClient,
  type ModelMessage,
  type ModelResponse,
  type StopReason,
  type ToolCall,
} from './types.js';
import { normalizeSchema } from './schema.js';

export const OPENAI_COMPAT = 'openai-compat';

export function createOpenAiCompatClient(
  baseURL: string,
  apiKey?: string,
  options: { fetch?: typeof fetch } = {},
): ModelClient {
  // local servers often need no key, but the sdk requires a value.
  const client = new OpenAI({ baseURL, apiKey: apiKey ?? 'none', maxRetries: 0, ...options });
  return {
    provider: OPENAI_COMPAT,
    async complete(call, signal) {
      const started = performance.now();
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(toOpenAiParams(call), { signal });
      } catch (err) {
        throw toModelError(err);
      }
      const earlier = call.messages.flatMap((message) => (message.role === 'assistant' ? message.toolCalls.map((each) => each.id) : []));
      return fromOpenAiCompletion(completion, Math.round(performance.now() - started), earlier);
    },
  };
}

export function toOpenAiParams(call: ModelCall): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    messages: [
      ...(call.system ? [{ role: 'system' as const, content: call.system }] : []),
      ...call.messages.flatMap(toOpenAiMessages),
    ],
    ...(call.tools.length
      ? {
          tools: call.tools.map((tool) => ({
            type: 'function' as const,
            function: { name: tool.name, description: tool.description, parameters: normalizeSchema(tool.inputSchema, 'openai-compat') },
          })),
        }
      : {}),
  };
}

// the chat format has one message per tool result, and these messages come directly after the assistant message.
function toOpenAiMessages(message: ModelMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (message.role === 'assistant') {
    if (!message.text && !message.toolCalls.length) return [];
    return [
      {
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      },
    ];
  }
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'tool_result') out.push({ role: 'tool', tool_call_id: block.toolCallId, content: block.content });
    else texts.push(block.text);
  }
  if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  return out;
}

// some servers number the calls of each reply from call_0, or give no id. the trace, the decisions and the repair after
// a crash find a call by its run and its id, so a repeated id would give a call the result of an older call. such a
// call gets a new id. the server only needs the ids to pair each call with its result in the next request.
export function fromOpenAiCompletion(completion: OpenAI.Chat.ChatCompletion, latencyMs: number, earlier: Iterable<string> = []): ModelResponse {
  const choice = completion.choices[0];
  const used = new Set(earlier);
  const uniqueId = (id: string | undefined) => {
    const unique = id && !used.has(id) ? id : `call_${randomBytes(8).toString('hex')}`;
    used.add(unique);
    return unique;
  };
  const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).flatMap((call) =>
    call.type === 'function' ? [{ id: uniqueId(call.id), name: call.function.name, input: parseArguments(call.function.arguments) }] : [],
  );
  const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    content: choice ? [choice.message] : [],
    toolCalls,
    text: choice?.message.content ?? '',
    stopReason: toStopReason(choice?.finish_reason),
    usage: {
      // other providers count cached tokens in the input. the anthropic count does not, so this adapter subtracts them.
      inputTokens: (completion.usage?.prompt_tokens ?? 0) - cached,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    model: completion.model,
    latencyMs,
  };
}

// a local model can write arguments that are not json. the raw text goes to the tool, and its validation reports
// the problem to the model.
function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function toStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function toModelError(err: unknown): ModelError {
  if (err instanceof OpenAI.APIUserAbortError) return new ModelError('aborted', 'the request was aborted');
  if (err instanceof OpenAI.APIConnectionError) return new ModelError('transient', err.message);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const transient = status === 408 || status === 409 || status === 429 || status >= 500;
    return new ModelError(transient ? 'transient' : 'request', err.message, status);
  }
  throw err;
}
