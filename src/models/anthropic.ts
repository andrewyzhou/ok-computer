import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaStopReason,
  BetaTool,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
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

// with this beta the api drops a thinking block that no longer matches the conversation. without it the request
// fails. a persona file edit or a new tool changes the prefix, so the agent must not fail on that change.
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export function createAnthropicClient(apiKey: string, options: { fetch?: typeof fetch } = {}): ModelClient {
  // the slot chain does the retries, so the sdk does not retry.
  const client = new Anthropic({ apiKey, maxRetries: 0, ...options });
  return {
    provider: ANTHROPIC,
    async complete(call, signal, onText) {
      const started = performance.now();
      let message: BetaMessage;
      // the message that a stream built so far. the sdk clears its own copy when a stream ends without message_stop.
      let partial: BetaMessage | undefined;
      try {
        // a stream sends the same body with stream: true, and finalMessage gives the same message as create.
        if (onText) {
          const stream = client.beta.messages.stream(toAnthropicParams(call), { signal });
          let text = '';
          stream.on('text', (delta) => onText((text += delta)));
          stream.on('streamEvent', (_event, snapshot) => (partial = snapshot));
          message = await stream.finalMessage();
        } else {
          message = await client.beta.messages.create(toAnthropicParams(call), { signal });
        }
      } catch (err) {
        const error = toModelError(err, signal);
        // the partial message holds the usage of message_start and of the last message_delta.
        if (partial) error.partial = fromAnthropicMessage(partial, Math.round(performance.now() - started));
        throw error;
      }
      return fromAnthropicMessage(message, Math.round(performance.now() - started));
    },
  };
}

// the rendered request must stay byte-stable between turns. the prompt cache and the thinking blocks both depend
// on an unchanged prefix. for this reason the function has no time values and no random values.
export function toAnthropicParams(call: ModelCall): MessageCreateParamsNonStreaming {
  // both breakpoints use the same time. the api refuses a 1-hour entry after a 5-minute entry.
  const cache = call.cacheTtl === '1h' ? { type: 'ephemeral' as const, ttl: '1h' as const } : { type: 'ephemeral' as const };
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    betas: [THINKING_BINDING_BETA],
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    ...(call.effort ? { output_config: { effort: call.effort } } : {}),
    // the explicit breakpoint keeps the tools and the stable system prompt cached. the top-level breakpoint
    // follows the end of the conversation.
    ...(call.system ? { system: [{ type: 'text', text: call.system, cache_control: cache }] } : {}),
    ...(call.tools.length
      ? {
          tools: call.tools.map(
            (tool): BetaTool => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as BetaTool.InputSchema,
            }),
          ),
        }
      : {}),
    cache_control: cache,
    messages: call.messages.flatMap(toAnthropicMessage),
  };
}

function toAnthropicMessage(message: ModelMessage): BetaMessageParam[] {
  if (message.role === 'user') {
    return [
      {
        role: 'user',
        content: message.content.map((block): BetaContentBlockParam =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'tool_result', tool_use_id: block.toolCallId, content: block.content, is_error: block.isError },
        ),
      },
    ];
  }
  // the api checks the thinking blocks against the earlier conversation, so the blocks go back unchanged.
  if (message.provider === ANTHROPIC) {
    return message.content.length ? [{ role: 'assistant', content: message.content as BetaContentBlockParam[] }] : [];
  }
  const content: BetaContentBlockParam[] = [
    ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
    ...message.toolCalls.map((call) => ({
      type: 'tool_use' as const,
      id: call.id,
      name: call.name,
      // the api accepts only an object as input. a local model can write arguments that are not json.
      input: call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : { _raw: call.input },
    })),
  ];
  return content.length ? [{ role: 'assistant', content }] : [];
}

export function fromAnthropicMessage(message: BetaMessage, latencyMs: number): ModelResponse {
  const toolCalls: ToolCall[] = [];
  let text = '';
  for (const block of message.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  const warnings = (message.input_transformations ?? []).map(
    (change) => `${change.type} at ${change.path}: ${change.reason}`,
  );
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
      cacheWrite1hTokens: message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    },
    model: message.model,
    latencyMs,
    ...(warnings.length ? { warnings } : {}),
  };
}

function toStopReason(reason: BetaStopReason | null): StopReason {
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

// the error types of the api, with the http status of each.
const STREAM_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

function toModelError(err: unknown, signal: AbortSignal | undefined): ModelError {
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return new ModelError('aborted', 'the request was aborted');
  if (err instanceof Anthropic.APIConnectionError) return new ModelError('transient', err.message);
  if (err instanceof Anthropic.APIError) {
    // an error event inside a stream has no status. its type gives the status that the same error has without a
    // stream, so a rate limit is retried, and a bad key does not count as an error that the input caused.
    const status = err.status || STREAM_ERROR_STATUS[String(err.type)] || 0;
    const transient = status === 408 || status === 409 || status === 429 || status >= 500;
    return new ModelError(transient ? 'transient' : 'request', err.message, status);
  }
  // a stream that the network cut, that ended before message_stop, or that sent bad json gives the base error of the
  // sdk. the request can go again, and the slot runner then records the failed call.
  if (err instanceof Anthropic.AnthropicError) return new ModelError('transient', err.message);
  throw err;
}
