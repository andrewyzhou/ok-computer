import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramChannel } from '../src/channels/telegram.js';
import type { InboundMessage, OutboundMessage, ReplyProgress } from '../src/channels/types.js';
import { WEB, WEB_CHAT_ID, type WebChannel, type WebChat } from '../src/channels/web.js';
import { getSetting } from '../src/db/settings.js';
import { parseIntegrations } from '../src/integrations/config.js';
import { fakeResponse, textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { silentLogger } from '../src/observability/logger.js';
import type { TurnHooks } from '../src/sessions/turns.js';
import { createTestApp } from './app-harness.js';
import { createFakeTelegram, textUpdate, until } from './fake-telegram.js';
import { createTestServer } from './mcp-server.js';

const OWNER = 777;
const pdt = (time: string) => new Date(`2026-10-12T${time}:00-07:00`).toISOString();

// a fake web channel: the hooks record each call, and its progress records what the run streamed. the real hub
// streams these to the open web clients.
function fakeWeb() {
  const calls: string[] = [];
  const streamed: string[] = [];
  const replies: OutboundMessage[] = [];
  const sent: OutboundMessage[] = [];
  const runIds: string[] = [];
  let onMessage: ((message: InboundMessage) => void) | undefined;
  const progress = (): ReplyProgress => ({
    text: (full) => void streamed.push(full),
    activity: () => {},
    end: async () => {},
    done: () => {},
  });
  const turns: TurnHooks = {
    owner: (m) => void calls.push(`owner ${m.channel} ${m.text}`),
    queued: (m, busy) => void calls.push(`queued ${m.channel} ${m.text} ${busy}`),
    started: (m, runId) => {
      calls.push(`started ${m.channel} ${m.text}`);
      runIds.push(runId);
      return progress();
    },
    replied: (m, out) => {
      calls.push(`replied ${m.channel} ${m.text}`);
      replies.push(out);
    },
    ended: (m, end) => void calls.push(`ended ${m.channel} ${m.text} ${end}`),
  };
  const chat: WebChat = {
    running: () => onMessage !== undefined,
    submit: () => undefined,
    press: () => false,
    stop: () => false,
    snapshot: () => [],
    subscribe: () => () => {},
  };
  const channel: WebChannel = {
    id: WEB,
    start: async (handler) => void (onMessage = handler),
    stop: async () => void (onMessage = undefined),
    send: async (out) => {
      sent.push(out);
      return { messageId: String(sent.length) };
    },
    chat,
    turns,
  };
  let ids = 0;
  // the dashboard signed in the request, so any sender id of the web channel is the owner.
  const say = (text: string) =>
    onMessage!({ channel: WEB, senderId: 'anyone', chatId: WEB_CHAT_ID, text, messageId: `web:${++ids}`, receivedAt: new Date().toISOString() });
  return { channel, calls, streamed, replies, sent, runIds, say };
}

function setup(steps: FakeStep[], options: { integrations?: boolean } = {}) {
  const telegram = createFakeTelegram();
  const web = fakeWeb();
  const entries = options.integrations
    ? parseIntegrations({ integrations: [{ id: 'notes', kind: 'mcp-stdio', command: 'node', args: ['server.js'], tools: { allow: ['add_note'] }, sessions: ['main'] }] })
    : undefined;
  if (entries && !entries.ok) throw new Error(entries.error);
  const transport = async (): Promise<Transport> => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await createTestServer().connect(server);
    return client;
  };
  const t = createTestApp(steps, {
    start: pdt('09:00'),
    deps: {
      channels: [createTelegramChannel({ bot: telegram.bot, ownerId: String(OWNER), logger: silentLogger, clock: () => t.clock() }), web.channel],
      ownerIds: { telegram: String(OWNER) },
      ...(entries ? { integrations: entries.value, mcpTransport: transport } : {}),
    },
  });
  const rich = () => telegram.calls.filter((c) => c.method === 'sendRichMessage').map((c) => (c.payload.rich_message as { markdown: string }).markdown);
  return { ...t, telegram, web, rich };
}

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

describe('telegram turns on the web', () => {
  it('calls the hooks in order for a telegram message, with the run id of its row and the streamed text', async () => {
    const t = setup([textStep('Hello there.')]);
    apps.push(t);
    await t.app.start();
    t.telegram.push(textUpdate(OWNER, 'hi'));
    await until(() => t.web.calls.some((call) => call.startsWith('ended')));
    expect(t.web.calls).toEqual(['owner telegram hi', 'queued telegram hi false', 'started telegram hi', 'replied telegram hi', 'ended telegram hi done']);
    expect(t.rows("SELECT id FROM runs WHERE trigger = 'message'")).toEqual([{ id: t.web.runIds[0] }]);
    expect(t.web.streamed.at(-1)).toBe('Hello there.');
    // the telegram adapter gives the plain message id of telegram as the messageId.
    expect(t.web.replies[0]).toMatchObject({ chatId: String(OWNER), text: 'Hello there.', markdown: true, runId: t.web.runIds[0], replyTo: '1' });
    expect(t.rich()).toEqual(['Hello there.']);
    expect(t.web.sent).toEqual([]);
  });

  it('trusts a web message from any sender id, and the model answers it on the web', async () => {
    const t = setup([textStep('Hi from the model.')]);
    apps.push(t);
    await t.app.start();
    t.web.say('hello');
    await t.settle();
    expect(t.model.calls).toHaveLength(1);
    expect(t.web.sent).toEqual([expect.objectContaining({ chatId: WEB_CHAT_ID, text: 'Hi from the model.', replyTo: 'web:1' })]);
    expect(t.web.calls).toEqual(['owner web hello', 'queued web hello false', 'started web hello', 'replied web hello', 'ended web hello done']);
  });

  it('queues a web message that comes while a telegram run is active, and runs it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup([
      async (_call, _signal, onText) => {
        onText?.('Thinking');
        await gate;
        return fakeResponse({ text: 'Telegram answer.' });
      },
      textStep('Web answer.'),
    ]);
    apps.push(t);
    await t.app.start();
    t.telegram.push(textUpdate(OWNER, 'think'));
    await until(() => t.web.streamed.includes('Thinking'));
    t.web.say('and this');
    expect(t.web.calls.at(-1)).toBe('queued web and this true');
    expect(t.model.calls).toHaveLength(1);
    release();
    await until(() => t.web.calls.includes('ended web and this done'));
    expect(t.web.calls.filter((call) => !call.startsWith('owner'))).toEqual([
      'queued telegram think false',
      'started telegram think',
      'queued web and this true',
      'replied telegram think',
      'ended telegram think done',
      'started web and this',
      'replied web and this',
      'ended web and this done',
    ]);
    expect(t.rich()).toEqual(['Telegram answer.']);
    expect(t.web.sent.map((out) => out.text)).toEqual(['Web answer.']);
  });
});

describe('proactive messages after a web message', () => {
  it('sends message_owner from a background run to telegram, not to the web', async () => {
    const t = setup([
      toolStep({
        id: 'a1',
        name: 'automations_create',
        input: { name: 'build', schedule: { kind: 'cron', expr: '0 10 * * *' }, payload: { type: 'agent', prompt: 'Tell the owner about the build.' } },
      }),
      textStep('Done.'),
      toolStep({ id: 'm1', name: 'message_owner', input: { text: 'The build is green.' } }),
      textStep('NO_REPLY'),
    ]);
    apps.push(t);
    await t.app.start();
    t.web.say('tell me about the build at 10am');
    await t.settle();
    expect(t.web.sent.map((out) => out.text)).toEqual(['Done.']);
    expect(getSetting(t.db, 'owner_chat')).toBeUndefined();
    await t.at(pdt('10:00'));
    expect(t.rich()).toEqual(['The build is green.']);
    expect(t.web.sent.map((out) => out.text)).toEqual(['Done.']);
  });

  it('sends the approval card of a run that a web message started to telegram, not to the web', async () => {
    const t = setup(
      [toolStep({ id: 'c1', name: 'tool_call', input: { name: 'notes__add_note', arguments: { note: 'buy milk' } } }), textStep('It waits for you.')],
      { integrations: true },
    );
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    t.web.say('add a note');
    await until(() => t.telegram.sent().some((m) => String(m.text).startsWith('Approval needed')));
    await t.app.idle();
    expect(t.web.sent.some((out) => out.text.startsWith('Approval needed'))).toBe(false);
  });
});
