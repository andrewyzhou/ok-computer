import type { Effort } from '../config/schema.js';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // the part of cacheWriteTokens that the provider keeps for 1 hour, at a higher rate.
  cacheWrite1hTokens?: number;
}

// an assistant turn keeps the provider blocks exactly as they arrived. the adapter of the same provider replays
// them unchanged. other adapters use the normalized text and tool calls.
export interface AssistantTurn {
  provider: string;
  model: string;
  content: unknown[];
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
}

export type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolCallId: string; content: string; isError: boolean };

export type ModelMessage = { role: 'user'; content: UserBlock[] } | ({ role: 'assistant' } & AssistantTurn);

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
}

export interface ModelCall extends ModelRequest {
  model: string;
  maxTokens: number;
  effort?: Effort;
  cacheTtl?: '5m' | '1h';
}

export interface ModelResponse {
  content: unknown[];
  toolCalls: ToolCall[];
  text: string;
  stopReason: StopReason;
  usage: Usage;
  model: string;
  latencyMs: number;
  // the provider changed the input before the model saw it, for example it dropped an old thinking block.
  warnings?: string[];
}

export interface ModelClient {
  provider: string;
  // complete throws ModelError when the provider fails. an adapter that streams gives onText the text so far. the
  // response is the same with or without it.
  complete(call: ModelCall, signal?: AbortSignal, onText?: (text: string) => void): Promise<ModelResponse>;
}

// transient errors can succeed on a retry. request errors fail again with the same request.
export type ModelErrorKind = 'transient' | 'request' | 'aborted';

export class ModelError extends Error {
  // a stream that failed or that the owner stopped can have sent text first. the owner saw it in the draft, so the
  // trace keeps it with its usage.
  partial?: ModelResponse;

  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
