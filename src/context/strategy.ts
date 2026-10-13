import type { StoredEvent } from '../events/log.js';
import type { ModelRequest, ToolSpec } from '../models/types.js';

export interface ContextInput {
  sessionKey: string;
  // the full history of the session, in order.
  events: StoredEvent[];
  system: string;
  tools: ToolSpec[];
}

// a strategy turns the event log into the model input. the log does not change, so a new strategy can run again
// over the full history.
export interface ContextStrategy {
  name: string;
  build(input: ContextInput): Promise<ModelRequest>;
}
