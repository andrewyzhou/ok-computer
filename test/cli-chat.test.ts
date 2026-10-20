import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createCliChannel } from '../src/channels/cli.js';
import { parseConfig } from '../src/config/load.js';
import { openDb } from '../src/db/index.js';
import { listEvents } from '../src/events/log.js';
import { createFakeClient, textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { silentLogger } from '../src/observability/logger.js';

function setup(steps: FakeStep[]) {
  const workspace = mkdtempSync(join(tmpdir(), 'okc-ws-'));
  writeFileSync(join(workspace, 'USER.md'), 'The owner likes short answers.');
  const parsed = parseConfig({
    slots: { main: { chain: ['fake/m'] } },
    pricing: { 'fake/m': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
    paths: { workspace, data: join(workspace, 'data') },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = openDb(':memory:');
  const model = createFakeClient(steps);
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  const clock = () => new Date('2026-10-13T03:15:00Z');
  const app = createApp({
    config: parsed.value,
    db,
    logger: silentLogger,
    clients: { fake: model },
    channels: [createCliChannel({ input, output, clock })],
    clock,
  });
  const say = async (line: string) => {
    input.write(line + '\n');
    await new Promise((resolve) => setImmediate(resolve));
    await app.idle();
  };
  return { app, db, model, say, printed: () => printed, dataDir: join(workspace, 'data') };
}

describe('cli chat through the full loop', () => {
  it('holds a conversation with tools, silence and a session reset', async () => {
    const { app, db, model, say, printed, dataDir } = setup([
      toolStep({ id: 't1', name: 'now', input: {} }),
      textStep('It is 20:15.'),
      textStep('NO_REPLY'),
      textStep('Hello again.'),
    ]);
    await app.start();

    await say('what time is it?');
    expect(printed()).toContain('okc> It is 20:15.');
    expect(model.calls[0]?.system).toContain('The owner likes short answers.');
    expect(model.calls[0]?.tools.map((t) => t.name)).toEqual([
      'automations_create',
      'automations_delete',
      'automations_list',
      'automations_update',
      'autonomy_levels',
      'autonomy_lower',
      'browser_allow_domain',
      'browser_back',
      'browser_click',
      'browser_close',
      'browser_extract',
      'browser_open',
      'browser_select',
      'browser_snapshot',
      'browser_submit',
      'browser_type',
      'delegate',
      'goal_update',
      'goals_list',
      'goals_set',
      'goals_stats',
      'heartbeat_checklist_set',
      'memory_get',
      'memory_search',
      'memory_write',
      'now',
      'result_read',
      'skill_read',
      'web_fetch',
      'web_search',
    ]);

    const before = printed();
    await say('just listen');
    expect(printed()).toBe(before);

    await say('/new');
    expect(printed()).toContain('okc> Started a new session.');
    expect(readFileSync(join(dataDir, 'memory', 'daily', '2026-10-12.md'), 'utf8')).toContain(
      '## notes\n\nSession closed with /new at 20:15. The last messages:\n- owner: what time is it?\n- assistant: It is 20:15.\n- owner: just listen',
    );
    await say('hi');
    expect(printed()).toContain('okc> Hello again.');
    expect(model.calls[3]?.messages).toHaveLength(1);

    const calls = db.prepare('SELECT costUsd FROM model_calls').all();
    expect(calls).toHaveLength(4);
    expect(calls.every((row) => typeof row.costUsd === 'number' && row.costUsd > 0)).toBe(true);
    expect(listEvents(db, 'main').filter((e) => e.type === 'session_reset')).toHaveLength(1);
    await app.stop();
  });

  it('tells the owner when a run fails', async () => {
    const { app, say, printed } = setup([]);
    await app.start();
    await say('hello');
    expect(printed()).toContain('okc> Sorry, I could not finish that:');
    await app.stop();
  });
});
