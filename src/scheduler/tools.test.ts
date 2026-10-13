import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createAutomation, getAutomation } from './store.js';
import { createAutomationTools } from './tools.js';

const NAMES = ['automations_create', 'automations_delete', 'automations_list', 'automations_update'];

function setup() {
  const db = openDb(':memory:');
  const now = new Date('2026-10-12T16:00:00Z');
  let replans = 0;
  const registry = createToolRegistry(createAutomationTools({ db, replan: () => replans++ }));
  const call = (name: string, input: unknown) =>
    registry.run({ id: 't', name, input }, NAMES, {
      runId: 'r',
      sessionKey: 'main',
      timeZone: 'America/Los_Angeles',
      clock: () => now,
      signal: new AbortController().signal,
    });
  return { db, now, call, replans: () => replans };
}

describe('automation tools', () => {
  it('shows fields with a default as optional to the model', () => {
    const { db } = setup();
    const [spec] = createToolRegistry(createAutomationTools({ db, replan: () => {} })).specs(['automations_create']);
    expect(spec?.inputSchema.required).toEqual(['name', 'schedule', 'payload']);
  });

  it('pauses, moves and deletes an automation by id', async () => {
    const { db, call, replans } = setup();
    const created = await call('automations_create', {
      name: 'ask',
      schedule: { kind: 'cron', expr: '0 19 * * *' },
      payload: { type: 'agent', prompt: 'ask' },
      sessionMode: 'main',
    });
    const id = /^created (\w+)/.exec(created.content)![1]!;

    const paused = await call('automations_update', { id, enabled: false });
    expect(paused.content).toContain('disabled');
    const moved = await call('automations_update', { id, enabled: true, schedule: { kind: 'cron', expr: '0 20 * * *' } });
    expect(moved.content).toContain('next Monday, October 12, 2026 at 20:00 PDT');
    expect(getAutomation(db, id)?.nextRunAt).toBe('2026-10-13T03:00:00.000Z');

    expect((await call('automations_delete', { id })).content).toBe(`deleted ${id}`);
    expect((await call('automations_list', {})).content).toBe('there are no automations');
    expect(replans()).toBe(4);
  });

  it('does not let the agent create or rewrite a system payload', async () => {
    const { db, now, call } = setup();
    const heartbeat = createAutomation(
      db,
      { name: 'heartbeat', schedule: { kind: 'every', everyMs: 30 * 60_000 }, payload: { type: 'heartbeat' }, createdBy: 'system' },
      now,
      'UTC',
    );
    if (!heartbeat.ok) throw new Error(heartbeat.error);
    const create = await call('automations_create', {
      name: 'x',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { type: 'heartbeat' },
    });
    expect(create.isError).toBe(true);
    const rewrite = await call('automations_update', { id: heartbeat.value.id, payload: { type: 'agent', prompt: 'hi' } });
    expect(rewrite).toEqual({ content: 'the payload of a heartbeat automation cannot change', isError: true });
    expect((await call('automations_update', { id: heartbeat.value.id, enabled: false })).isError).toBeUndefined();
  });

  it('refuses a one-shot time in the past', async () => {
    const { call } = setup();
    const out = await call('automations_create', {
      name: 'late',
      schedule: { kind: 'at', at: '2026-10-12T08:00:00-07:00' },
      payload: { type: 'agent', prompt: 'x' },
    });
    expect(out).toEqual({ content: 'the time of this one-shot automation is in the past', isError: true });
  });
});
