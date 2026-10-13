import { ModelError, type ModelCall, type ModelClient, type ModelResponse, type ToolCall } from './types.js';

export const FAKE = 'fake';

export type FakeStep =
  | Partial<ModelResponse>
  | ModelError
  | ((call: ModelCall, signal?: AbortSignal, onText?: (text: string) => void) => Promise<ModelResponse>);

export interface FakeClient extends ModelClient {
  calls: ModelCall[];
}

// the fake client returns its scripted steps in order. it records every call, so tests can check the requests.
export function createFakeClient(steps: FakeStep[], provider = FAKE): FakeClient {
  const queue = [...steps];
  const calls: ModelCall[] = [];
  return {
    provider,
    calls,
    async complete(call, signal, onText) {
      calls.push(structuredClone(call));
      const step = queue.shift();
      if (!step) throw new Error(`fake model has no step for call ${calls.length}`);
      if (step instanceof ModelError) throw step;
      if (typeof step === 'function') return step(call, signal, onText);
      if (step.text) onText?.(step.text);
      return fakeResponse({ ...step, model: step.model ?? call.model });
    },
  };
}

export function fakeResponse(partial: Partial<ModelResponse>): ModelResponse {
  const text = partial.text ?? '';
  const toolCalls = partial.toolCalls ?? [];
  return {
    content: partial.content ?? [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map((call) => ({ type: 'tool_use', ...call })),
    ],
    toolCalls,
    text,
    stopReason: partial.stopReason ?? (toolCalls.length ? 'tool_use' : 'end_turn'),
    usage: partial.usage ?? { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: partial.model ?? 'fake-model',
    latencyMs: partial.latencyMs ?? 1,
  };
}

export function textStep(text: string): Partial<ModelResponse> {
  return { text };
}

export function toolStep(...toolCalls: ToolCall[]): Partial<ModelResponse> {
  return { toolCalls };
}
