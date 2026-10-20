import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDoc, getDoc, getVersion, listVersions } from '../src/docs/store.js';
import { listEvents } from '../src/events/log.js';
import { fakeResponse, textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { BUILTIN_RULES } from '../src/policy/policy.js';
import { REMOVED_LINK, REPLY_TOOL } from '../src/policy/reply.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { createTestServer } from './mcp-server.js';
import { notesIntegration } from './seed-integrations.js';
import { fixtureEgress, startFixture, type Fixture } from './web-fixture.js';

// the docs through the whole app: the fake model calls the doc tools, and the tool caller, the policy, the trace and
// the reply guard see each call as they see any other tool.

const start = '2026-10-13T16:00:00Z';
const TRIP_BODY = ['# Trip plan: Lisbon', '', ...Array.from({ length: 20 }, (_, i) => `- day ${i + 1}: walk and eat well.`)].join('\n');
const write = (id: string) => toolStep({ id, name: 'doc_write', input: { title: 'Trip plan: Lisbon', kind: 'plan', body: TRIP_BODY } });

let site: Fixture;
beforeAll(async () => {
  site = await startFixture();
});
afterAll(() => site?.close());

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

function app(steps: FakeStep[], deps: Parameters<typeof createTestApp>[1]['deps'] = {}) {
  const t = createTestApp(steps, { start, deps: { web: { egress: fixtureEgress() }, ...deps } });
  apps.push(t);
  return t;
}

// the model copies the link of the tool result into its reply, as the prompt tells it to.
const replyWithLink: FakeStep = async (call) => {
  const link = /this link: (https?:\/\/[^\s"\\]+)/.exec(JSON.stringify(call.messages))?.[1] ?? 'no link';
  return fakeResponse(textStep(`Your trip plan is ready: ${link}`));
};

const linkOf = (port: number, id: number) => `http://127.0.0.1:${port}/#/docs/${id}`;
const resultOf = (t: ReturnType<typeof app>, id: string) =>
  listEvents(t.db, 'main').find((event) => event.type === 'tool_result' && event.payload.toolCallId === id)?.payload as
    | { content: string; isError: boolean; untrustedSource?: string }
    | undefined;

describe('docs in the app', () => {
  it('writes a long answer as a doc and replies with a short line and its link', async () => {
    const t = app([write('w1'), replyWithLink]);
    await t.app.start();
    await t.say('plan a five day trip to Lisbon for me');
    const port = t.config.dashboard.port;

    const run = t.rows("SELECT id FROM runs WHERE sessionKey = 'main'")[0] as { id: string };
    expect(getDoc(t.db, 1)).toMatchObject({ title: 'Trip plan: Lisbon', kind: 'plan', version: 1, author: 'agent', sessionKey: 'main', tainted: false });
    expect(getVersion(t.db, 1, 1)).toMatchObject({ version: 1, author: 'agent', runId: run.id, toolCallId: 'w1', body: TRIP_BODY });
    expect(t.rows('SELECT runId, toolCallId, name, isError FROM tool_calls')).toEqual([{ runId: run.id, toolCallId: 'w1', name: 'doc_write', isError: 0 }]);
    expect(t.rows('SELECT toolCallId, toolName, decision, rule, reviewerModelCallId FROM policy_decisions')).toEqual([
      { toolCallId: 'w1', toolName: 'doc_write', decision: 'allow', rule: 'builtin:doc_write', reviewerModelCallId: null },
    ]);
    // two calls of the main model and no call of a reviewer.
    expect(t.model.calls).toHaveLength(2);
    expect(t.printed()).toContain(`okc> Your trip plan is ready: ${linkOf(port, 1)}`);
    // the prompt tells the model to write a long answer as a doc.
    expect(t.model.calls[0]!.system).toContain('write it with doc_write');
    expect(t.model.calls[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['doc_list', 'doc_read', 'doc_search', 'doc_update', 'doc_write']));
  });

  it('refuses a doc_update on a stale base version and adds no version', async () => {
    const t = app([
      write('w1'),
      toolStep({ id: 'u1', name: 'doc_update', input: { id: 1, baseVersion: 1, body: 'version two', note: 'shorter' } }),
      toolStep({ id: 'u2', name: 'doc_update', input: { id: 1, baseVersion: 1, body: 'version three', note: 'from an old read' } }),
      textStep('Updated.'),
    ]);
    await t.app.start();
    await t.say('write it, then change it');
    expect(resultOf(t, 'u1')).toMatchObject({ isError: false, content: expect.stringContaining('Saved doc #1 "Trip plan: Lisbon" (version 2).') });
    expect(resultOf(t, 'u2')).toMatchObject({ isError: true, content: 'doc #1 is at version 2, not 1. Read it again before you change it' });
    expect(listVersions(t.db, 1).map((each) => each.version)).toEqual([2, 1]);
    expect(getVersion(t.db, 1, 2)!.body).toBe('version two');
  });

  it('taints the session that reads a tainted version, so a following external call needs the owner', async () => {
    const transport = async (): Promise<Transport> => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      await createTestServer().connect(server);
      return client;
    };
    // the owner allows add_note, so only the taint can make the second call wait.
    const rules = [...BUILTIN_RULES, { id: 'okc.policy.json#1', tool: 'notes__add_note', effect: 'allow' as const }];
    const note = (id: string) => toolStep({ id, name: 'tool_call', input: { name: 'notes__add_note', arguments: { note: 'pack the adapter' } } });
    // the first read is of a doc without taint, so only the second read can make the call wait. the result of an
    // integration call taints the session too, so the call comes after the reads.
    const t = app(
      [toolStep({ id: 'r0', name: 'doc_read', input: { id: 1 } }), toolStep({ id: 'r1', name: 'doc_read', input: { id: 2 } }), note('n1'), textStep('It waits for you.')],
      { integrations: notesIntegration(), mcpTransport: transport, rules },
    );
    const taint = [{ source: 'web_fetch: https://reviews.example.com/laptops', toolName: 'web_fetch', runId: null, toolCallId: 'f0', at: start }];
    expect(createDoc(t.db, { title: 'Packing list', kind: 'notes', body: 'adapter', author: 'agent' }, new Date(start)).ok).toBe(true);
    expect(createDoc(t.db, { title: 'Laptop comparison', kind: 'comparison', body: 'the pick', author: 'agent', taint }, new Date(start)).ok).toBe(true);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');

    await t.say('read the packing list and the laptop doc, then note the adapter');
    expect(resultOf(t, 'r0')?.untrustedSource).toBeUndefined();
    const source = 'doc #2 version 1, written after reading web_fetch: https://reviews.example.com/laptops';
    expect(resultOf(t, 'r1')?.untrustedSource).toBe(source);
    expect(sessionTaint(t.db, 'main').map((each) => [each.source, each.toolName])).toEqual([[source, 'doc_read']]);
    expect(t.rows('SELECT toolCallId, decision, rule, reason FROM policy_decisions ORDER BY id')).toEqual([
      { toolCallId: 'r0', decision: 'allow', rule: 'risk:read', reason: 'doc_read only reads' },
      { toolCallId: 'r1', decision: 'allow', rule: 'risk:read', reason: 'doc_read only reads' },
      { toolCallId: 'n1', decision: 'approve', rule: 'taint', reason: `the session read untrusted content (${source}), so an external action needs the owner's approval` },
    ]);
    expect(t.rows('SELECT toolName, status FROM approvals')).toEqual([{ toolName: 'notes__add_note', status: 'pending' }]);
  });

  it('gives an automation session the doc tools', async () => {
    const t = app([
      toolStep({
        id: 'a1',
        name: 'automations_create',
        input: { name: 'brief', schedule: { kind: 'at', at: '2026-10-13T17:00:00Z' }, payload: { type: 'agent', prompt: 'Write the morning brief.' } },
      }),
      textStep('Done.'),
      write('w1'),
      textStep('NO_REPLY'),
    ]);
    await t.app.start();
    await t.say('write me a brief at 10');
    await t.at('2026-10-13T17:00:00Z');
    const automation = t.model.calls[2]!;
    expect(automation.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['doc_list', 'doc_read', 'doc_search', 'doc_update', 'doc_write']));
    const [run] = t.rows("SELECT sessionKey, trigger FROM runs WHERE trigger = 'automation'") as Array<{ sessionKey: string; trigger: string }>;
    expect(run!.sessionKey).toMatch(/^auto:/);
    expect(getDoc(t.db, 1)).toMatchObject({ sessionKey: run!.sessionKey, author: 'agent' });
  });
});

describe('the reply guard and the doc link', () => {
  // a web page makes the session tainted. the reply that links to the doc should still reach the chat as it is. it
  // does not yet: the link has a fragment (#/docs/1), so dataUrls counts it as a link that can carry data, and urlSeen
  // does not exempt it, because it counts only tool results with an untrusted source and the result of doc_write has
  // none. the reply then goes to the reviewer, and without a verdict of allow the chat gets it without the link. the
  // test is marked as failing until the guard knows the links of the dashboard; then the mark comes off.
  it.fails('lets the link of a doc reach the chat in a tainted session', async () => {
    const t = app([toolStep({ id: 'f1', name: 'web_fetch', input: { url: site.url('shop.test') } }), write('w1'), replyWithLink]);
    const port = t.config.dashboard.port;
    await t.app.start();
    await t.say('read the shop page and plan the trip');
    expect(resultOf(t, 'f1')?.untrustedSource).toBeTruthy();
    expect(sessionTaint(t.db, 'main').length).toBeGreaterThan(0);
    expect(resultOf(t, 'w1')?.content).toContain(linkOf(port, 1));
    expect(t.rows('SELECT decision, rule FROM policy_decisions WHERE toolName = ?', 'doc_write')).toEqual([{ decision: 'allow', rule: 'builtin:doc_write' }]);
    expect(t.rows('SELECT toolName FROM policy_decisions WHERE toolName = ?', REPLY_TOOL)).toEqual([]);
    expect(t.printed()).not.toContain(REMOVED_LINK);
    expect(t.printed()).toContain(`okc> Your trip plan is ready: ${linkOf(port, 1)}`);
  });

  // what the guard does today, so a change of it shows up here. the reply keeps its words and loses only the link.
  it('today sends the reply of a tainted session to review and removes the doc link', async () => {
    const t = app([toolStep({ id: 'f1', name: 'web_fetch', input: { url: site.url('shop.test') } }), write('w1'), replyWithLink]);
    const port = t.config.dashboard.port;
    await t.app.start();
    await t.say('read the shop page and plan the trip');
    expect(t.rows('SELECT decision, rule, reason FROM policy_decisions WHERE toolName = ?', REPLY_TOOL)).toEqual([
      { decision: 'review', rule: 'exfiltration', reason: expect.stringContaining(`(${linkOf(port, 1)}): it has a query or a fragment`) },
    ]);
    expect(t.printed()).toContain(`okc> Your trip plan is ready: ${REMOVED_LINK}`);
    // the event log keeps the full reply, so the run page shows the link.
    expect(JSON.stringify(listEvents(t.db, 'main'))).toContain(`Your trip plan is ready: ${linkOf(port, 1)}`);
  });
});
