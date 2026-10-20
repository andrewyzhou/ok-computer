import { describe, expect, it } from 'vitest';
import { DESK_INSTRUCTIONS } from '../src/desk/index.js';
import { listDelegationEvents } from '../src/desk/store.js';
import { createFakeClient, textStep, toolStep } from '../src/models/fake.js';
import { REVIEW_TOOL } from '../src/policy/reviewer.js';
import { createTestApp } from './app-harness.js';

const DESK_TOOLS = ['delegation_create', 'delegation_done', 'delegation_list', 'delegation_update', 'delegation_wait_on'];

describe('the desk in chat', () => {
  it('makes a delegation from an owner request, and the reply names it', async () => {
    // the harness keeps the default port of the dashboard.
    const link = 'http://127.0.0.1:4317/#/desk?id=1';
    const main = createFakeClient([
      toolStep({ id: 'd1', name: 'delegation_create', input: { title: 'Book the Denver flights', dueAt: '2026-10-24', nextStep: 'Compare the morning flights' } }),
      textStep(`On your desk as #1 "Book the Denver flights". ${link}`),
    ]);
    // a desk tool changes data, so the reviewer on the utility slot checks it first, as in test/review.test.ts.
    const reviewer = createFakeClient([toolStep({ id: 'v', name: REVIEW_TOOL, input: { verdict: 'allow', reason: 'the owner asked for it' } })], 'rev');
    const t = createTestApp([], {
      start: '2026-10-20T17:00:00.000Z',
      config: { slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['rev/r'] } } },
      deps: { clients: { fake: main, rev: reviewer } },
    });
    await t.app.start();
    await t.say('can you handle booking the Denver flights for Oct 24?');
    expect(t.printed()).toContain(`okc> On your desk as #1 "Book the Denver flights". ${link}`);

    const [run] = t.rows("SELECT id FROM runs WHERE sessionKey = 'main'") as Array<{ id: string }>;
    const [row] = t.rows('SELECT id, title, status, createdBy, sessionKey, runId, dueAt FROM delegations');
    expect(row).toEqual({
      id: 1,
      title: 'Book the Denver flights',
      status: 'open',
      createdBy: 'agent',
      sessionKey: 'main',
      runId: run!.id,
      dueAt: '2026-10-25T06:59:00.000Z',
    });
    expect(t.rows('SELECT kind, ref, account, label FROM delegation_links WHERE delegationId = 1')).toEqual([
      { kind: 'run', ref: run!.id, account: '', label: 'The run that created it' },
    ]);
    const history = listDelegationEvents(t.db, 1);
    expect(history.map((each) => [each.kind, each.actor, each.runId, each.toolCallId])).toEqual([
      ['created', 'agent', run!.id, 'd1'],
      ['link_added', 'agent', run!.id, 'd1'],
    ]);

    // the trace keeps the call, and its output is the answer that the reply quotes.
    const [call] = t.rows("SELECT runId, name, isError, output FROM tool_calls WHERE name = 'delegation_create'") as Array<Record<string, unknown>>;
    expect(call).toMatchObject({ runId: run!.id, isError: 0 });
    expect(JSON.parse(String(call!.output))).toEqual({ content: `Added to the desk as #1 "Book the Denver flights" (open). ${link}\nDue: Saturday, October 24, 2026 at 23:59 PDT` });

    expect(t.rows("SELECT decision, rule, reviewerVerdict FROM policy_decisions WHERE toolCallId = 'd1'")).toEqual([
      { decision: 'review', rule: 'risk:write', reviewerVerdict: 'allow' },
    ]);
    // the model saw the tool output in its second call.
    expect(JSON.stringify(main.calls[1]!.messages)).toContain('Added to the desk as #1');
    await t.app.stop();
  });

  it('gives the main session the desk instructions and all five tools, and an automation only the list', async () => {
    const t = createTestApp([], { start: '2026-10-20T17:00:00.000Z' });
    const main = await t.app.contextView('main');
    expect(DESK_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(main.system).toContain(DESK_INSTRUCTIONS);
    const mainTools = main.tools.map((tool) => tool.name);
    for (const name of DESK_TOOLS) expect(mainTools).toContain(name);

    const auto = await t.app.contextView('auto:x:y');
    expect(auto.system).not.toContain(DESK_INSTRUCTIONS);
    expect(auto.tools.map((tool) => tool.name).filter((name) => name.startsWith('delegation_'))).toEqual(['delegation_list']);
  });
});
