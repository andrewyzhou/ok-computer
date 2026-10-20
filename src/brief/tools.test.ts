import { describe, expect, it } from 'vitest';
import { BRIEF_FULL, TODAY_NOW, TODAY_TZ } from '../../test/fixtures/today-data.js';
import { runTool } from '../../test/run-tool.js';
import { seedBriefRows } from '../../test/seed-today.js';
import { openDb } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { deleteAutomation, updateAutomation } from '../scheduler/store.js';
import { createRunQueue } from '../sessions/queue.js';
import { createToolRegistry } from '../tools/registry.js';
import { briefAutomation, installBrief } from './install.js';
import { BRIEF_TOOLS, createBriefTools } from './tools.js';

function setup() {
  const db = openDb(':memory:');
  seedBriefRows(db);
  const now = new Date(TODAY_NOW);
  installBrief(db, { timeZone: TODAY_TZ }, new Date('2026-10-12T14:00:00Z'));
  let replans = 0;
  const tools = createBriefTools({
    db,
    clock: () => now,
    logger: silentLogger,
    timeZone: TODAY_TZ,
    owner: { send: async () => true, chat: () => undefined },
    queue: createRunQueue(),
    dashboardUrl: 'http://127.0.0.1:7777',
    signal: new AbortController().signal,
    replan: () => replans++,
    newId: () => 'run-1',
  });
  const registry = createToolRegistry(tools);
  const call = (name: string, input: unknown) =>
    runTool(registry, { id: 't', name, input }, BRIEF_TOOLS, { runId: 'r', sessionKey: 'main', timeZone: TODAY_TZ, clock: () => now, signal: new AbortController().signal });
  return { db, call, replans: () => replans };
}

describe('brief tools', () => {
  it('reads the brief of today with the source of each item', async () => {
    const { call } = setup();
    const out = await call('brief_read', {});
    expect(out.isError).toBeUndefined();
    expect(out.untrustedSource).toBe('brief');
    const lines = out.content.split('\n');
    expect(lines[0]).toBe('Brief of 2026-10-12, built 07:30.');
    expect(lines).toContain('- Run with Sam: 07:00 to 07:45 · Memorial Glade [event personal/primary/run]');
    expect(lines).toContain('- Advisor 1:1 overlaps Dentist: 14:15 to 14:30 [event school/primary/advisor]');
    expect(lines).toContain('- Essay draft for HIST 7B: Due Tomorrow 23:59 · from the inbox [thread school/t-essay]');
    expect(lines).toContain('- Problem set 4 due: Wed · proposed, waiting for your approval [proposal 7]');
    expect(lines).toContain('- Get the refund from the airline: Follow up today [delegation 4]');
    expect(lines).toContain('- gym [goal 2]');
    // a section shows its title, then its note.
    const inbox = lines.indexOf('Inbox');
    expect(lines[inbox + 1]).toBe('2 need a reply, 1 bill, 1 package.');
    const items = BRIEF_FULL.content.sections.reduce((sum, section) => sum + section.items.length, 0);
    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(items);
  });

  it('reads the brief of another day, and says when there is none', async () => {
    const { db, call } = setup();
    expect((await call('brief_read', { day: '2026-10-11' })).content).toBe('Brief of 2026-10-11, built 07:30.\n\nSchedule\nGoogle is not set up, so the brief has no calendar.');
    expect(await call('brief_read', { day: '2026-10-13' })).toEqual({ content: 'there is no brief for 2026-10-13 yet. it is built each day at 07:30.', untrustedSource: 'brief' });
    const id = briefAutomation(db)!.id;
    updateAutomation(db, id, { enabled: false }, new Date(TODAY_NOW), TODAY_TZ);
    expect((await call('brief_read', { day: '2026-10-13' })).content).toBe('there is no brief for 2026-10-13 yet. the brief is turned off.');
    deleteAutomation(db, id);
    expect((await call('brief_read', { day: '2026-10-13' })).content).toBe('there is no brief for 2026-10-13 yet. the brief is turned off.');
    expect((await call('brief_read', { day: 'monday' })).isError).toBe(true);
  });

  it('moves the brief and plans again', async () => {
    const { db, call, replans } = setup();
    const out = await call('brief_set_time', { time: '08:00' });
    expect(out).toEqual({ content: 'the brief now comes at 08:00 each day. the next one is Monday, October 12, 2026 at 08:00 PDT.' });
    expect(replans()).toBe(1);
    expect(briefAutomation(db)?.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *', tz: TODAY_TZ });
    deleteAutomation(db, briefAutomation(db)!.id);
    expect((await call('brief_set_time', { time: '06:45' })).content).toBe('the brief now comes at 06:45 each day. the next one is Tuesday, October 13, 2026 at 06:45 PDT.');
    expect(briefAutomation(db)?.enabled).toBe(true);
    const bad = await call('brief_set_time', { time: '24:00' });
    expect(bad.isError).toBe(true);
    expect(replans()).toBe(2);
  });
});
