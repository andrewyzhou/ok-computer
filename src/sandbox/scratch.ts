import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import type { DockerClient } from './types.js';

// a task is one segment of a session, from a reset to the next reset. the calls of a task share one docker volume at
// /work, so a call can use the files of an earlier call. the volume is a docker volume and not a host folder, so it also
// works when the app runs in a container and talks to the docker of its host (phase 5 m7).

export interface Scratch {
  // the task id and the volume of the session now. the volume is made on the first call of a task, and its row in
  // sandbox_scratch is written then. lastUsedAt changes at each call.
  volumeFor(sessionKey: string): Promise<{ taskId: string; volume: string }>;
  // after a call: a volume over SCRATCH_BYTES is removed, and the result tells the model that /work is empty again.
  // size is the size that the runner measured, or undefined when it could not.
  afterExec(taskId: string, size: number | undefined): Promise<{ reset: boolean }>;
  // sweep removes the volumes that no call used for SCRATCH_IDLE_MS, and the labelled volumes of this instance that
  // have no row. it gives the number of volumes that it removed.
  sweep(): Promise<number>;
}

// the task id is stable for a session segment: a hash of the session key and the id of its last session_reset event
// (0 before the first reset). a /new then gives a fresh /work.
export function taskIdOf(_db: Db, _sessionKey: string): string {
  throw new Error('not built: taskIdOf');
}

export function createScratch(_deps: { db: Db; docker: DockerClient; clock: Clock; instance: string }): Scratch {
  throw new Error('not built: createScratch');
}
