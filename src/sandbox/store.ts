import type { Db } from '../db/index.js';
import type { ExecEnd, FileRow, NewExec } from './types.js';

// the trace rows of the sandbox: sandbox_execs and sandbox_files (020_sandbox.sql). the row of an exec is written
// before the container starts and finished after it ends, so a crash leaves a running row that closeStale ends.

export function startExec(_db: Db, _exec: NewExec, _now: Date): number {
  throw new Error('not built: startExec');
}

export function finishExec(_db: Db, _id: number, _end: ExecEnd, _now: Date): void {
  throw new Error('not built: finishExec');
}

export function addFiles(_db: Db, _execId: number, _rows: FileRow[], _now: Date): void {
  throw new Error('not built: addFiles');
}

// closeStale gives status error and the reason "the app stopped while the command ran" to each running row that is
// older than staleMs and not in live. it gives the ids that it closed.
export function closeStale(_db: Db, _now: Date, _staleMs: number, _live: ReadonlySet<number>): number[] {
  throw new Error('not built: closeStale');
}
