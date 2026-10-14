import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILES } from '../src/agent/delegate.js';
import { fullHistory } from '../src/context/full-history.js';
import { getRunDetail } from '../src/dashboard/queries.js';
import { openDb } from '../src/db/index.js';
import { listEvents } from '../src/events/log.js';
import { textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { ModelError, type ModelCall } from '../src/models/types.js';
import { createTestApp } from './app-harness.js';
import { CLIENT_ID } from './google-harness.js';
import { danglingToolCalls } from './harness.js';

const start = '2026-10-13T09:00:00-07:00';
const delegate = (id: string, task = `task ${id}`) => toolStep({ id, name: 'delegate', input: { profile: 'research', task } });
const search = (id: string) => toolStep({ id, name: 'memory_search', input: { query: 'notes' } });
// a model call that waits until its run stops, as a slow provider does.
const hang: FakeStep = (_call, signal) =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(new ModelError('aborted', 'aborted'));
    signal?.addEventListener('abort', () => reject(new ModelError('aborted', 'aborted')));
  });

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

// a second app on the same database is a second process. its run ids must differ, as random ids do.
let processes = 0;
function app(steps: FakeStep[], extra: { config?: Record<string, unknown>; db?: ReturnType<typeof openDb>; at?: string } = {}) {
  const prefix = `p${++processes}-`;
  let ids = 0;
  const t = createTestApp(steps, {
    start: extra.at ?? start,
    ...(extra.config ? { config: extra.config } : {}),
    deps: { newId: () => `${prefix}${++ids}`, ...(extra.db ? { db: extra.db } : {}) },
  });
  apps.push(t);
  return t;
}

const result = (db: ReturnType<typeof openDb>, id: string) =>
  listEvents(db, 'main').find((event) => event.type === 'tool_result' && event.payload.toolCallId === id)?.payload as
    | { content: string; isError: boolean }
    | undefined;
const userText = (call: ModelCall) =>
  call.messages.flatMap((message) => (message.role === 'user' ? message.content : [])).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

describe('sub-agents in the app', () => {
  it('gives a child no persona, no owner facts, no goals and no automations', async () => {
    const t = app([delegate('d1'), textStep('Found nothing.'), textStep('Done.')]);
    await t.app.start();
    await t.say('look something up');
    const [parent, child] = t.model.calls;
    expect(parent!.system).toContain('The owner likes short answers.');
    expect(child!.system).not.toContain('The owner likes short answers.');
    expect(child!.system).toContain('You are a sub-agent.');
    // the main session sees the routine of the owner. the child sees only its task and the time.
    expect(userText(parent!)).toMatch(/goals/i);
    expect(userText(child!)).not.toMatch(/goals|automation/i);
    expect(userText(child!)).toContain('Your task from the parent agent:\ntask d1');
    expect(child!.tools.map((tool) => tool.name)).toEqual(['memory_get', 'memory_search', 'result_read', 'web_fetch', 'web_search']);
    expect(t.rows("SELECT trigger, slot, status FROM runs WHERE sessionKey LIKE 'sub:%'")).toEqual([{ trigger: 'subagent', slot: 'main', status: 'completed' }]);
  });

  it('stops a child at the limit of its profile, reports what it has, and does not message the owner', async () => {
    const limit = PROFILES.research.maxIterations;
    const steps = Array.from({ length: limit }, (_, i) => (i === limit - 1 ? { text: 'Most notes read.', toolCalls: [{ id: `k${i}`, name: 'memory_search', input: { query: 'x' } }] } : search(`k${i}`)));
    const t = app([delegate('d1'), ...steps, textStep('The helper ran out of steps.')]);
    await t.app.start();
    await t.say('search my notes');
    expect(result(t.db, 'd1')).toMatchObject({
      isError: true,
      content: expect.stringMatching(new RegExp(`stopped after ${limit} model calls[\\s\\S]*Its last text:\\nMost notes read\\.\\nIts tool calls: (memory_search \\(ran\\), ){${limit - 1}}memory_search \\(ran\\)\\.`)),
    });
    expect(t.printed()).not.toContain('did not finish');
    expect(t.printed()).toContain('The helper ran out of steps.');
  });

  it('stops a child when its parent stops, and leaves no call without a result in the parent', async () => {
    const t = app([delegate('d1'), hang], { config: { agent: { chatTimeoutMs: 50 } } });
    await t.app.start();
    await t.say('go');
    await expect.poll(() => t.rows("SELECT status FROM runs WHERE trigger = 'subagent'")).toEqual([{ status: 'aborted' }]);
    expect(t.rows("SELECT status FROM runs WHERE sessionKey = 'main'")).toEqual([{ status: 'aborted' }]);
    const request = await fullHistory.build({ sessionKey: 'main', events: listEvents(t.db, 'main'), system: '', tools: [] });
    expect(danglingToolCalls(request.messages)).toEqual([]);
  });

  it('after a crash during a child, the sweep closes both runs, and the next parent run marks the delegate call interrupted', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'okc-sub-')), 'okc.sqlite');
    const first = app([delegate('d1'), search('k1'), hang], { db: openDb(path) });
    await first.app.start();
    await first.type('go');
    await expect.poll(() => first.rows("SELECT COUNT(*) AS n FROM tool_calls WHERE toolCallId = 'k1'")).toEqual([{ n: 1 }]);

    // a second process opens the same database two hours later. for the database, the first one is gone.
    const second = app([textStep('Sorry, that task was cut off.')], { db: openDb(path), at: '2026-10-13T11:00:00-07:00' });
    await second.app.start();
    await second.settle();
    expect(second.rows('SELECT trigger, status FROM runs ORDER BY trigger')).toEqual([
      { trigger: 'message', status: 'aborted' },
      { trigger: 'subagent', status: 'aborted' },
    ]);
    // before the next parent run, the run page shows the call as interrupted, not as running.
    const [parent] = second.rows("SELECT id FROM runs WHERE trigger = 'message'") as Array<{ id: string }>;
    const shown = getRunDetail(second.db, parent!.id)!.timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call]));
    expect(shown.find((call) => call.toolCallId === 'd1')).toMatchObject({ outcome: 'interrupted', isError: true, child: { status: 'aborted' } });
    await second.say('what happened?');
    expect(result(second.db, 'd1')?.content).toContain('unknown whether it finished');
    expect(second.rows("SELECT outcome FROM tool_calls WHERE toolCallId = 'd1'")).toEqual([{ outcome: 'interrupted' }]);
  });

  // each profile name must match a real tool. a wrong name is left out without an error, so only this test sees it.
  it('gives each profile every tool that it names, when the app has google', async () => {
    const t = app([textStep('hi')], { config: { google: { clientId: CLIENT_ID, accounts: [{ alias: 'personal' }] } } });
    await t.app.start();
    await t.say('hi');
    const description = t.model.calls[0]!.tools.find((tool) => tool.name === 'delegate')!.description;
    const missing = Object.fromEntries(
      Object.entries(PROFILES).map(([name, profile]) => {
        const line = description.split('\n').find((each) => each.startsWith(`- ${name}:`)) ?? '';
        const live = line.slice(line.indexOf('Tools: ') + 7).replace(/\.$/, '').split(', ');
        return [name, profile.tools.filter((tool) => !live.includes(tool))];
      }),
    );
    expect(missing).toEqual({ browser: [], research: [], inbox: [] });
  });
});
