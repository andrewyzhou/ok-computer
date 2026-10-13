import type { StoredEvent } from '../events/log.js';
import type { ModelRequest, ToolSpec } from '../models/types.js';

export interface CompactionHooks {
  runId: string;
  signal: AbortSignal;
  // flush runs one silent turn in the same session with this text as a system event. it gives the final text.
  flush(text: string): Promise<{ status: string; text: string }>;
}

export interface ContextInput {
  sessionKey: string;
  // the full history of the session, in order.
  events: StoredEvent[];
  system: string;
  tools: ToolSpec[];
  // a run gives the hooks when the strategy may compact the session before the model call.
  compaction?: CompactionHooks;
}

// a strategy turns the event log into the model input. the log does not change, so a new strategy can run again
// over the full history.
export interface ContextStrategy {
  name: string;
  build(input: ContextInput): Promise<ModelRequest>;
}
