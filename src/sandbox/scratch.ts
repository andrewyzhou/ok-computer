import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { DockerError } from './docker.js';
import { LABELS, SCRATCH_BYTES, SCRATCH_IDLE_MS } from './limits.js';
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
export function taskIdOf(db: Db, sessionKey: string): string {
  const row = db.prepare("SELECT MAX(id) AS id FROM events WHERE sessionKey = ? AND type = 'session_reset'").get(sessionKey) as { id: number | null } | undefined;
  const reset = row?.id ?? 0;
  return createHash('sha256').update(`${sessionKey}@${reset}`).digest('hex').slice(0, 16);
}

// a 409 is a volume that a container still uses. the sweep leaves it for the next time.
const inUse = (err: unknown) => err instanceof DockerError && err.status === 409;

export function createScratch(deps: { db: Db; docker: DockerClient; clock: Clock; instance: string }): Scratch {
  const { db, docker, clock, instance } = deps;

  const markRemoved = (id: string) => db.prepare('UPDATE sandbox_scratch SET removedAt = ? WHERE id = ?').run(clock().toISOString(), id);

  return {
    async volumeFor(sessionKey) {
      const taskId = taskIdOf(db, sessionKey);
      const volume = `okc-work-${instance}-${taskId}`;
      // the engine gives the same volume again for a name that exists, so the create runs at each call. a volume
      // that someone removed by hand is then made again.
      await docker.createVolume(volume, { [LABELS.sandbox]: '1', [LABELS.instance]: instance, [LABELS.task]: taskId });
      const now = clock().toISOString();
      db.prepare(
        `INSERT INTO sandbox_scratch (id, sessionKey, volume, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET lastUsedAt = excluded.lastUsedAt, removedAt = NULL`,
      ).run(taskId, sessionKey, volume, now, now);
      return { taskId, volume };
    },

    async afterExec(taskId, size) {
      if (size === undefined || size <= SCRATCH_BYTES) return { reset: false };
      const row = db.prepare('SELECT volume FROM sandbox_scratch WHERE id = ?').get(taskId) as { volume: string } | undefined;
      if (!row) return { reset: false };
      await docker.removeVolume(row.volume);
      markRemoved(taskId);
      return { reset: true };
    },

    async sweep() {
      let removed = 0;
      const cutoff = new Date(clock().getTime() - SCRATCH_IDLE_MS).toISOString();
      const idle = db.prepare('SELECT id, volume FROM sandbox_scratch WHERE removedAt IS NULL AND lastUsedAt < ?').all(cutoff) as Array<{ id: string; volume: string }>;
      for (const row of idle) {
        try {
          await docker.removeVolume(row.volume);
        } catch (err) {
          if (inUse(err)) continue;
          throw err;
        }
        markRemoved(row.id);
        removed += 1;
      }

      const live = new Set((db.prepare('SELECT volume FROM sandbox_scratch WHERE removedAt IS NULL').all() as Array<{ volume: string }>).map((row) => row.volume));
      for (const volume of await docker.listVolumes(`${LABELS.instance}=${instance}`)) {
        if (live.has(volume.name)) continue;
        try {
          await docker.removeVolume(volume.name);
        } catch (err) {
          if (inUse(err)) continue;
          throw err;
        }
        removed += 1;
      }
      return removed;
    },
  };
}
