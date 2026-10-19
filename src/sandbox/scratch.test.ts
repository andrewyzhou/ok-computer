import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { DockerError } from './docker.js';
import { LABELS, SCRATCH_BYTES, SCRATCH_IDLE_MS } from './limits.js';
import { createScratch, taskIdOf } from './scratch.js';
import type { DockerClient } from './types.js';

interface Row {
  id: string;
  sessionKey: string;
  volume: string;
  createdAt: string;
  lastUsedAt: string;
  removedAt: string | null;
}

function fakeVolumes() {
  const volumes = new Map<string, Record<string, string>>();
  const inUse = new Set<string>();
  const removed: string[] = [];
  const docker = {
    async createVolume(name: string, labels: Record<string, string>) {
      if (!volumes.has(name)) volumes.set(name, labels);
    },
    async removeVolume(name: string) {
      if (inUse.has(name)) throw new DockerError('volume is in use', 409);
      volumes.delete(name);
      removed.push(name);
    },
    async listVolumes(label: string) {
      const [key, value] = label.split('=');
      return [...volumes].filter(([, labels]) => labels[key!] !== undefined && (value === undefined || labels[key!] === value)).map(([name, labels]) => ({ name, labels }));
    },
  } as Partial<DockerClient> as DockerClient;
  return { docker, volumes, inUse, removed };
}

describe('scratch', () => {
  let db: Db;
  let now: Date;
  const clock = () => now;

  beforeEach(() => {
    db = openDb(':memory:');
    now = new Date('2026-10-01T12:00:00.000Z');
  });

  const rows = () => db.prepare('SELECT * FROM sandbox_scratch ORDER BY createdAt, id').all() as unknown as Row[];

  it('gives a stable task id that changes after a session reset', () => {
    const first = taskIdOf(db, 'main');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(taskIdOf(db, 'main')).toBe(first);
    expect(taskIdOf(db, 'auto:job')).not.toBe(first);
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'user_message', payload: { text: 'hi', channel: 'cli', chatId: 'c' } }, now);
    expect(taskIdOf(db, 'main')).toBe(first);
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} }, now);
    const second = taskIdOf(db, 'main');
    expect(second).not.toBe(first);
    // a reset of another session does not change this one.
    appendEvent(db, { sessionKey: 'other', runId: null, type: 'session_reset', payload: {} }, now);
    expect(taskIdOf(db, 'main')).toBe(second);
  });

  it('makes the volume with its labels and upserts the row', async () => {
    const fake = fakeVolumes();
    const scratch = createScratch({ db, docker: fake.docker, clock, instance: 'inst' });
    const { taskId, volume } = await scratch.volumeFor('main');
    expect(taskId).toBe(taskIdOf(db, 'main'));
    expect(volume).toBe(`okc-work-inst-${taskId}`);
    expect(fake.volumes.get(volume)).toEqual({ [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.task]: taskId });
    expect(rows()).toEqual([{ id: taskId, sessionKey: 'main', volume, createdAt: now.toISOString(), lastUsedAt: now.toISOString(), removedAt: null }]);

    const created = now.toISOString();
    now = new Date(now.getTime() + 60_000);
    expect(await scratch.volumeFor('main')).toEqual({ taskId, volume });
    expect(rows()).toEqual([{ id: taskId, sessionKey: 'main', volume, createdAt: created, lastUsedAt: now.toISOString(), removedAt: null }]);
  });

  it('gives a fresh volume after a session reset', async () => {
    const scratch = createScratch({ db, docker: fakeVolumes().docker, clock, instance: 'inst' });
    const before = await scratch.volumeFor('main');
    appendEvent(db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} }, now);
    const after = await scratch.volumeFor('main');
    expect(after.volume).not.toBe(before.volume);
    expect(rows()).toHaveLength(2);
  });

  it('removes a volume over the size limit after a call, and a later call makes it again', async () => {
    const fake = fakeVolumes();
    const scratch = createScratch({ db, docker: fake.docker, clock, instance: 'inst' });
    const { taskId, volume } = await scratch.volumeFor('main');
    expect(await scratch.afterExec(taskId, undefined)).toEqual({ reset: false });
    expect(await scratch.afterExec(taskId, SCRATCH_BYTES)).toEqual({ reset: false });
    expect(fake.volumes.has(volume)).toBe(true);

    expect(await scratch.afterExec(taskId, SCRATCH_BYTES + 1)).toEqual({ reset: true });
    expect(fake.volumes.has(volume)).toBe(false);
    expect(rows()[0]!.removedAt).toBe(now.toISOString());

    await scratch.volumeFor('main');
    expect(fake.volumes.has(volume)).toBe(true);
    expect(rows()[0]!.removedAt).toBeNull();
  });

  it('sweeps idle volumes and labelled volumes with no row', async () => {
    const fake = fakeVolumes();
    const scratch = createScratch({ db, docker: fake.docker, clock, instance: 'inst' });
    const old = await scratch.volumeFor('auto:old');
    const busy = await scratch.volumeFor('auto:busy');
    now = new Date(now.getTime() + SCRATCH_IDLE_MS + 1000);
    const fresh = await scratch.volumeFor('main');
    fake.inUse.add(busy.volume);
    // an orphan of this instance, a volume of another instance, and a volume that is not of the sandbox.
    await fake.docker.createVolume('okc-work-inst-orphan', { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst' });
    await fake.docker.createVolume('okc-work-other-x', { [LABELS.sandbox]: '1', [LABELS.instance]: 'other' });
    await fake.docker.createVolume('someone-else', {});

    expect(await scratch.sweep()).toBe(2);
    expect(fake.removed.sort()).toEqual([old.volume, 'okc-work-inst-orphan'].sort());
    expect([...fake.volumes.keys()].sort()).toEqual([busy.volume, fresh.volume, 'okc-work-other-x', 'someone-else'].sort());
    const byId = new Map(rows().map((row) => [row.id, row]));
    expect(byId.get(old.taskId)!.removedAt).toBe(now.toISOString());
    expect(byId.get(busy.taskId)!.removedAt).toBeNull();
    expect(byId.get(fresh.taskId)!.removedAt).toBeNull();

    // a second sweep finds nothing new, and the busy volume waits until it is free.
    expect(await scratch.sweep()).toBe(0);
    fake.inUse.clear();
    expect(await scratch.sweep()).toBe(1);
    expect(fake.volumes.has(busy.volume)).toBe(false);
  });

  it('does not keep the sweep from the other idle volumes when one removal fails', async () => {
    const db = openDb(':memory:');
    let now = new Date('2026-10-01T00:00:00Z');
    const removed: string[] = [];
    let first = '';
    const docker = {
      createVolume: async () => {},
      removeVolume: async (name: string) => { if (name === first) throw new DockerError('the volume driver failed', 500); removed.push(name); },
      listVolumes: async () => [],
    } as unknown as DockerClient;
    const scratch = createScratch({ db, docker, clock: () => now, instance: 'i' });
    first = (await scratch.volumeFor('main')).volume;
    const second = (await scratch.volumeFor('auto:1')).volume;
    now = new Date(now.getTime() + SCRATCH_IDLE_MS + 1);
    await scratch.sweep().catch(() => 0);
    expect(removed).toContain(second);
  });
});

describe('the scratch sweep and a call at the same time', () => {
  it('keeps the volume of a task that starts while the sweep lists the volumes', async () => {
    const db = openDb(':memory:');
    const volumes = new Map<string, Record<string, string>>();
    const removed: string[] = [];
    let scratch: ReturnType<typeof createScratch> | undefined;
    let made = '';
    const docker = {
      createVolume: async (name: string, labels: Record<string, string>) => void volumes.set(name, labels),
      removeVolume: async (name: string) => {
        volumes.delete(name);
        removed.push(name);
      },
      // a call of a new task makes its volume while the list is on the way.
      listVolumes: async () => {
        made = (await scratch!.volumeFor('auto:9')).volume;
        return [...volumes.entries()].map(([name, labels]) => ({ name, labels }));
      },
    } as unknown as DockerClient;
    scratch = createScratch({ db, docker, clock: () => new Date('2026-10-01T00:00:00Z'), instance: 'i' });
    expect(await scratch.sweep()).toBe(0);
    expect(removed).toEqual([]);
    expect(volumes.has(made)).toBe(true);
  });
});
