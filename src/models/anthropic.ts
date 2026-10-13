import Anthropic from '@anthropic-ai/sdk';
import {
  ModelError,
  type ModelCall,
  type ModelClient,
  type ModelMessage,
  type ModelResponse,
  type StopReason,
  type ToolCall,
} from './types.js';

export const ANTHROPIC = 'anthropic';

export function createAnthropicClient(apiKey: string, options: { fetch?: typeof fetch } = {}): ModelClient {
  // the slot chain does the retries, so the sdk does not retry.
  const client = new Anthropic({ apiKey, maxRetries: 0, ...options });
  return {
    provider: ANTHROPIC,
    async complete(call, signal) {
      const started = performance.now();
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(toAnthropicParams(call), { signal });
      } catch (err) {
        throw toModelError(err);
      }
      return fromAnthropicMessage(message, Math.round(performance.now() - started));
    },
  };
}

// the rendered request must stay byte-stable between turns. the prompt cache and the thinking blocks both depend
// on an unchanged prefix. for this reason the function has no time values and no random values.
export function toAnthropicParams(call: ModelCall): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    thinking: { type: 'adaptive' },
    ...(call.effort ? { output_config: { effort: call.effort } } : {}),
    // the explicit breakpoint keeps the tools and the stable system prompt cached. the top-level breakpoint
    // follows the end of the conversation.
    ...(call.system ? { system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }] } : {}),
    ...(call.tools.length
      ? {
          tools: call.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
    cache_control: { type: 'ephemeral' },
    messages: call.messages.flatMap(toAnthropicMessage),
  };
}

function toAnthropicMessage(message: ModelMessage): Anthropic.MessageParam[] {
  if (message.role === 'user') {
    return [
      {
        role: 'user',
        content: message.content.map((block): Anthropic.ContentBlockParam =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'tool_result', tool_use_id: block.toolCallId, content: block.content, is_error: block.isError },
        ),
      },
    ];
  }
  // the api checks the thinking blocks against the earlier conversation, so the blocks go back unchanged.
  if (message.provider === ANTHROPIC) {
    return message.content.length ? [{ role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] }] : [];
  }
  const content: Anthropic.ContentBlockParam[] = [
    ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
    ...message.toolCalls.map((call) => ({
      type: 'tool_use' as const,
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  ];
  return content.length ? [{ role: 'assistant', content }] : [];
}

export function fromAnthropicMessage(message: Anthropic.Message, latencyMs: number): ModelResponse {
  const toolCalls: ToolCall[] = [];
  let text = '';
  for (const block of message.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return {
    content: message.content,
    toolCalls,
    text,
    stopReason: toStopReason(message.stop_reason),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    model: message.model,
    latencyMs,
  };
}

function toStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function toModelError(err: unknown): ModelError {
  if (err instanceof Anthropic.APIUserAbortError) return new ModelError('aborted', 'the request was aborted');
  if (err instanceof Anthropic.APIConnectionError) return new ModelError('transient', err.message);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const transient = status === 408 || status === 409 || status === 429 || status >= 500;
    return new ModelError(transient ? 'transient' : 'request', err.message, status);
  }
  throw err;
}
