import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import type { Tool } from '../tools/registry.js';
import type { FileStores } from './files.js';
import type { Scratch } from './scratch.js';
import type { NetworkGate, Probe, Runner } from './types.js';

export const SANDBOX_EXEC = 'sandbox_exec';

export interface SandboxToolDeps {
  db: Db;
  stores: FileStores;
  runner: Runner;
  scratch: Scratch;
  network: NetworkGate;
  logger: Logger;
  clock: Clock;
  image: string;
  // the last probe. the tool gives an error with effect none when docker does not answer.
  probe: () => Probe;
  // the ids of the execs that run now in this process. the tool adds and removes its own id.
  live: Set<number>;
}

// sandbox_exec runs code in a fresh container (see docs/PHASE5-API.md, M9). risk exec goes to the reviewer. a call
// with network access is external, so the owner approves it.
export function createSandboxExecTool(_deps: SandboxToolDeps): Tool {
  throw new Error('not built: createSandboxExecTool');
}
