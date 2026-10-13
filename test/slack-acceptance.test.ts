import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { parseIntegrations } from '../src/integrations/config.js';
import { textStep, toolStep } from '../src/models/fake.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { ALICE, createSlackFake, DM_ALICE, type SlackFake } from './slack-server.js';

// the whole app with a fake of the official slack server: dms become signals on the scheduler tick without a model
// call, and a send waits for the owner. the oauth sign-in has its own tests over http (slack-oauth.test.ts).

const START = '2026-10-13T09:00:00-07:00';

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

function slackEntries() {
  const parsed = parseIntegrations({
    integrations: [
      {
        id: 'slack-work',
        kind: 'mcp-http',
        url: 'https://mcp.slack.example/mcp',
        tools: { allow: ['slack_search_public_and_private', 'slack_read_user_profile', 'slack_read_channel', 'slack_send_message'] },
        risk: { slack_search_public_and_private: 'read', slack_read_user_profile: 'read', slack_read_channel: 'read', slack_send_message: 'external' },
        poll: 'slack-dms',
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const call = (id: string, name: string, args: Record<string, unknown>) => toolStep({ id, name: 'tool_call', input: { name, arguments: args } });

async function slackApp(steps: Parameters<typeof createTestApp>[0], options: { connect?: boolean } = {}) {
  let t: ReturnType<typeof createTestApp> | undefined;
  const fake: SlackFake = createSlackFake(() => Math.floor((t?.clock() ?? new Date(START)).getTime() / 1000));
  const transport = async (): Promise<Transport> => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await fake.server().connect(server);
    return client;
  };
  t = createTestApp(steps, {
    start: START,
    deps: { integrations: slackEntries(), mcpTransport: transport, ...(options.connect === false ? { connectIntegrations: false } : {}) },
  });
  apps.push(t);
  await t.app.start();
  if (options.connect !== false) await expect.poll(() => t!.app.integrations.status()[0]!.state.status).toBe('connected');
  const poll = () => t!.rows("SELECT id, enabled, nextRunAt, consecutiveFailures FROM automations WHERE json_extract(payload, '$.type') = 'integration_poll'")[0] as {
    id: string;
    enabled: number;
    nextRunAt: string | null;
  };
  const dm = (ago: number, text: string) => {
    const message = { channel: DM_ALICE, ts: `${Math.floor(t!.clock().getTime() / 1000) - ago}.000100`, user: ALICE, text };
    fake.messages.push(message);
    return message;
  };
  return { t, fake, poll, dm };
}

describe('slack acceptance', () => {
  it('turns a dm into a signal on the scheduler tick, without a model call', async () => {
    const { t, fake, poll, dm } = await slackApp([]);
    const message = dm(600, 'can you send the deck by 5pm?');
    expect(poll()).toMatchObject({ enabled: 1, nextRunAt: '2026-10-13T16:15:00.000Z' });
    await t.at('2026-10-13T16:15:00.000Z');
    expect(t.rows('SELECT account, externalId, kind, untrustedSource FROM integration_events')).toEqual([
      { account: 'slack-work', externalId: `${DM_ALICE}:${message.ts}`, kind: 'dm', untrustedSource: 'mcp:slack-work' },
    ]);
    expect(t.rows('SELECT status, runId, error FROM automation_runs')).toEqual([{ status: 'completed', runId: null, error: null }]);
    expect(t.rows('SELECT COUNT(*) AS n FROM model_calls')).toEqual([{ n: 0 }]);
    expect(t.rows('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 0 }]);
    expect(fake.calls).toEqual(['slack_read_user_profile', 'slack_search_public_and_private']);
  });

  it('asks the owner before a send after a slack read, sends once after the approval, and never calls a tool that the config does not allow', async () => {
    const reply = 'On it, the deck comes at 5.';
    const { t, fake } = await slackApp([
      toolStep(
        { id: 'c1', name: 'tool_call', input: { name: 'slack-work__slack_search_public_and_private', arguments: { filters: 'after:2026-10-12', channel_types: 'im' } } },
        { id: 'c2', name: 'tool_call', input: { name: 'slack-work__slack_schedule_message', arguments: { channel_id: DM_ALICE, message: 'later', post_at: 1 } } },
      ),
      call('c3', 'slack-work__slack_send_message', { channel_id: DM_ALICE, message: reply }),
      textStep('I asked you before I send it.'),
    ]);
    await t.say('answer alice that the deck comes at 5');
    // the search ran, and its slack text tainted the session.
    expect(sessionTaint(t.db, 'main').map((source) => source.source)).toContain('mcp:slack-work');
    // the scheduled message is not in tools.allow, so it never reached the server.
    expect(fake.calls).toEqual(['slack_search_public_and_private']);
    expect(t.rows("SELECT toolName, decision FROM policy_decisions WHERE toolCallId = 'c3'")).toEqual([{ toolName: 'slack-work__slack_send_message', decision: 'approve' }]);
    // the card shows the channel and the exact text, and nothing went out yet.
    expect(t.printed()).toContain(`channel_id: "${DM_ALICE}"`);
    expect(t.printed()).toContain(`message: "${reply}"`);
    expect(fake.sent).toEqual([]);

    const { id } = t.rows("SELECT id FROM approvals WHERE toolName = 'slack-work__slack_send_message'")[0] as { id: number };
    await t.app.resolveApproval(id, 'approve', 'dashboard');
    await t.settle();
    expect(fake.sent).toEqual([{ channel_id: DM_ALICE, message: reply }]);
    await t.app.resolveApproval(id, 'approve', 'dashboard');
    await t.settle();
    expect(fake.sent).toHaveLength(1);
  });

  it('turns the poll off after five failed polls and tells the owner once, without the text of the answer', async () => {
    const { t, fake, poll } = await slackApp([]);
    fake.faults.format = 'garbage';
    fake.messages.push({ channel: DM_ALICE, ts: '1792000000.000100', user: ALICE, text: 'x' });
    for (let i = 0; i < 5; i++) await t.at(poll().nextRunAt!);
    expect(poll()).toMatchObject({ enabled: 0, nextRunAt: null });
    const told = t.printed().match(/failed 5 times in a row, so I turned it off\. The last error was: [^\n]*/g);
    expect(told).toEqual([expect.stringMatching(/could not be read: it has no message that the reader knows\. The JSON-RPC messages of the call show the raw answer\.$/)]);
    expect(t.printed()).not.toMatch(/new look|widget/);
  });

  // a claim in the chat process would use up the slot of the service, which then skipped the poll.
  it('leaves the poll to the service in the chat process, which never connects', async () => {
    const { t, fake, poll } = await slackApp([], { connect: false });
    const due = poll().nextRunAt!;
    await t.at(due);
    expect(t.rows('SELECT status, error FROM automation_runs')).toEqual([]);
    expect(poll().nextRunAt).toBe(due);
    expect(fake.calls).toEqual([]);
  });
});
