import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { DockerError } from './docker.js';
import { errorText } from '../tools/registry.js';
import { DOCKER_STEP_MS, LABELS, SCRATCH_BYTES, SCRATCH_IDLE_MS } from './limits.js';
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
      // the row is written before the volume, so a sweep that runs at the same time never finds the new labelled
      // volume without a row and removes it. a row whose volume could not be made is harmless: the idle sweep ends it.
      const now = clock().toISOString();
      db.prepare(
        `INSERT INTO sandbox_scratch (id, sessionKey, volume, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET lastUsedAt = excluded.lastUsedAt, removedAt = NULL`,
      ).run(taskId, sessionKey, volume, now, now);
      // the engine gives the same volume again for a name that exists, so the create runs at each call. a volume
      // that someone removed by hand is then made again.
      await docker.createVolume(volume, { [LABELS.sandbox]: '1', [LABELS.instance]: instance, [LABELS.task]: taskId }, AbortSignal.timeout(DOCKER_STEP_MS));
      return { taskId, volume };
    },

    async afterExec(taskId, size) {
      if (size === undefined || size <= SCRATCH_BYTES) return { reset: false };
      const row = db.prepare('SELECT volume FROM sandbox_scratch WHERE id = ?').get(taskId) as { volume: string } | undefined;
      if (!row) return { reset: false };
      await docker.removeVolume(row.volume, AbortSignal.timeout(DOCKER_STEP_MS));
      markRemoved(taskId);
      return { reset: true };
    },

    async sweep() {
      let removed = 0;
      const failures: unknown[] = [];
      // one volume that cannot be removed must not keep the others on disk, so each removal fails on its own, and the
      // sweep reports the failures after the loops.
      const tryRemove = async (name: string): Promise<boolean> => {
        try {
          await docker.removeVolume(name, AbortSignal.timeout(DOCKER_STEP_MS));
          return true;
        } catch (err) {
          if (!inUse(err)) failures.push(err);
          return false;
        }
      };
      const cutoff = () => new Date(clock().getTime() - SCRATCH_IDLE_MS).toISOString();
      const stillIdle = db.prepare('SELECT 1 AS x FROM sandbox_scratch WHERE id = ? AND removedAt IS NULL AND lastUsedAt < ?');
      const idle = db.prepare('SELECT id, volume FROM sandbox_scratch WHERE removedAt IS NULL AND lastUsedAt < ?').all(cutoff()) as Array<{ id: string; volume: string }>;
      for (const row of idle) {
        // a task can resume while the sweep runs, so the row is read again just before the removal.
        if (stillIdle.get(row.id, cutoff()) === undefined) continue;
        if (!(await tryRemove(row.volume))) continue;
        markRemoved(row.id);
        removed += 1;
      }

      // the rows are read after the list, and again before each removal, so a volume that a new task made while the
      // list ran is never taken for one without a row.
      const found = await docker.listVolumes(`${LABELS.instance}=${instance}`, AbortSignal.timeout(DOCKER_STEP_MS));
      const hasRow = db.prepare('SELECT 1 AS x FROM sandbox_scratch WHERE volume = ? AND removedAt IS NULL');
      const live = new Set((db.prepare('SELECT volume FROM sandbox_scratch WHERE removedAt IS NULL').all() as Array<{ volume: string }>).map((row) => row.volume));
      for (const volume of found) {
        if (live.has(volume.name) || hasRow.get(volume.name) !== undefined) continue;
        if (await tryRemove(volume.name)) removed += 1;
      }
      if (failures.length) {
        throw new Error(`the sweep removed ${removed} volumes, and ${failures.length} could not be removed: ${failures.map(errorText).join('; ')}`);
      }
      return removed;
    },
  };
}
