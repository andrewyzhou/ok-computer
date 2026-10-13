import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, createTelegramChannel } from '../src/channels/telegram.js';
import { listEvents } from '../src/events/log.js';
import { parseIntegrations } from '../src/integrations/config.js';
import { fakeResponse, textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { ModelError } from '../src/models/types.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { buttonUpdate, createFakeTelegram, stopUpdate, textUpdate, until } from './fake-telegram.js';
import { createTestServer } from './mcp-server.js';

const OWNER = 777;
const start = '2026-10-13T09:00:00-07:00';

// the whole app with telegram as its only channel, a fake model, and an in-memory server whose add_note is external.
function setup(steps: FakeStep[], options: { integrations?: boolean; policyPath?: string; config?: Record<string, unknown> } = {}) {
  const telegram = createFakeTelegram();
  const entries = options.integrations
    ? parseIntegrations({
        integrations: [{ id: 'notes', kind: 'mcp-stdio', command: 'node', args: ['server.js'], tools: { allow: ['add_note'] }, sessions: ['main'] }],
      })
    : undefined;
  if (entries && !entries.ok) throw new Error(entries.error);
  const transport = async (): Promise<Transport> => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await createTestServer().connect(server);
    return client;
  };
  const t = createTestApp(steps, {
    start,
    ...(options.config ? { config: options.config } : {}),
    deps: {
      channels: [createTelegramChannel({ bot: telegram.bot, logger: silentLogger, clock: () => t.clock() })],
      ownerIds: { telegram: String(OWNER) },
      ...(entries ? { integrations: entries.value, mcpTransport: transport } : {}),
      ...(options.policyPath ? { policyPath: options.policyPath } : {}),
    },
  });
  return { ...t, telegram };
}

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const each of apps.splice(0)) await each.app.stop();
});

const of = (t: ReturnType<typeof setup>, method: string) => t.telegram.calls.filter((c) => c.method === method).map((c) => c.payload);
const owner = (t: ReturnType<typeof setup>, text: string) => t.telegram.push(textUpdate(OWNER, text));
const press = (t: ReturnType<typeof setup>, data: string) => t.telegram.push(buttonUpdate(OWNER, data));
const call = (id: string, name: string, args: Record<string, unknown>) => toolStep({ id, name: 'tool_call', input: { name, arguments: args } });

describe('telegram v2 acceptance', () => {
  it('sends a markdown reply as a rich message, and sets the commands menu', async () => {
    const t = setup([textStep('## Today\n\n- **Gym** at 7\n- Read')]);
    apps.push(t);
    await t.app.start();
    owner(t, 'plan my day');
    await until(() => of(t, 'sendRichMessage').length === 1);
    expect(of(t, 'sendRichMessage')).toEqual([{ chat_id: String(OWNER), rich_message: { markdown: '## Today\n\n- **Gym** at 7\n- Read' } }]);
    expect(of(t, 'sendMessage')).toEqual([]);
    expect(of(t, 'setMyCommands')).toEqual([{ commands: COMMANDS }]);
    expect(COMMANDS.map((c) => c.command)).toEqual(['new', 'status', 'goals', 'approvals', 'dashboard', 'stop']);
  });

  it('streams a long reply into a draft with a stop button, then saves it as one rich message', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const full = `Here is the plan.\n\n${Array.from({ length: 700 }, (_, i) => `- step ${i}`).join('\n')}`;
    expect(full.length).toBeGreaterThan(4096);
    const streamed: FakeStep = async (_call, _signal, onText) => {
      onText!(full.slice(0, 100));
      vi.advanceTimersByTime(1000);
      onText!(full.slice(0, 3000));
      vi.advanceTimersByTime(1000);
      onText!(full);
      vi.advanceTimersByTime(1000);
      return fakeResponse({ text: full });
    };
    const t = setup([streamed]);
    apps.push(t);
    await t.app.start();
    owner(t, 'write the long plan');
    await until(() => of(t, 'sendRichMessage').length === 1);
    await t.app.idle();

    const drafts = of(t, 'sendMessageDraft');
    // the first draft is empty, which shows "Thinking…". a long draft shows its end.
    expect(drafts.map((d) => d.text)).toEqual(['', full.slice(0, 100), full.slice(0, 3000), `…${full.slice(-4095)}`]);
    expect(new Set(drafts.map((d) => `${d.chat_id}:${d.draft_id}:${d.can_stop}`))).toEqual(new Set([`${OWNER}:1:true`]));
    expect(of(t, 'sendRichMessage')).toEqual([{ chat_id: String(OWNER), rich_message: { markdown: full } }]);
    // no draft goes out after the saved message.
    const methods = t.telegram.calls.map((c) => c.method);
    expect(methods.lastIndexOf('sendMessageDraft')).toBeLessThan(methods.indexOf('sendRichMessage'));
    expect(of(t, 'setMessageReaction').map((r) => r.reaction)).toEqual([[{ type: 'emoji', emoji: '👀' }], [{ type: 'emoji', emoji: '👌' }]]);
    // the event log keeps the full reply, as it did without streaming.
    const saved = listEvents(t.db, 'main').filter((e) => e.type === 'assistant_message');
    expect((saved[0]!.payload as { text: string }).text).toBe(full);
  });

  it('stops the run when the owner presses stop on the draft, and ignores a stop from another chat', async () => {
    const waits: FakeStep = (_call, signal, onText) => {
      onText!('Working on');
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new ModelError('aborted', 'the request was aborted'))),
      );
    };
    const t = setup([waits, textStep('Fresh answer.')]);
    apps.push(t);
    await t.app.start();
    owner(t, 'write an essay');
    await until(() => of(t, 'sendMessageDraft').length === 1);
    const draftId = Number(of(t, 'sendMessageDraft')[0]!.draft_id);

    // the open poll returns the stranger's update. the next poll shows that the bot handled it. the run still runs.
    const polls = () => t.telegram.calls.filter((c) => c.method === 'getUpdates').length;
    const before = polls();
    t.telegram.push(stopUpdate(555, draftId));
    await until(() => polls() >= before + 1);
    expect(t.rows("SELECT status FROM runs WHERE sessionKey = 'main'")).toEqual([{ status: 'running' }]);
    t.telegram.push(stopUpdate(OWNER, draftId));
    await until(() => of(t, 'sendMessage').some((m) => m.text === 'Stopped.'));
    await t.app.idle();

    expect(t.rows("SELECT status, error FROM runs WHERE sessionKey = 'main'")).toEqual([{ status: 'aborted', error: 'the run was aborted' }]);
    expect(of(t, 'sendRichMessage')).toEqual([]);
    expect(of(t, 'setMessageReaction').map((r) => r.reaction)).toEqual([[{ type: 'emoji', emoji: '👀' }], []]);
    const events = listEvents(t.db, 'main');
    expect(events.at(-1)).toMatchObject({ type: 'system_event', payload: { text: 'The owner stopped the previous reply before it was done.' } });

    // the next message runs normally.
    owner(t, 'hi');
    await until(() => of(t, 'sendRichMessage').length === 1);
    expect(of(t, 'sendRichMessage')[0]).toMatchObject({ rich_message: { markdown: 'Fresh answer.' } });
  });

  it('stops the run with /stop, which does not wait behind the run', async () => {
    const waits: FakeStep = (_call, signal) =>
      new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new ModelError('aborted', 'the request was aborted'))));
    const t = setup([waits]);
    apps.push(t);
    await t.app.start();
    owner(t, 'think about it for a long time');
    await until(() => of(t, 'sendMessageDraft').length === 1);
    owner(t, '/stop');
    await until(() => of(t, 'sendMessage').some((m) => m.text === 'Stopped.'));
    await t.app.idle();
    expect(t.rows("SELECT status FROM runs WHERE sessionKey = 'main'")).toEqual([{ status: 'aborted' }]);
    // /stop never reached the model or the log.
    expect(t.model.calls).toHaveLength(1);
    expect(JSON.stringify(listEvents(t.db, 'main'))).not.toContain('/stop');
    owner(t, '/stop');
    await until(() => of(t, 'sendMessage').some((m) => m.text === 'Nothing runs now.'));
  });

  it('answers /status, /goals, /approvals and /dashboard in code', async () => {
    const t = setup([], { config: { dashboard: { url: 'https://okc-pc.example.ts.net' } } });
    apps.push(t);
    await t.app.start();
    for (const command of ['/status', '/goals', '/approvals', '/dashboard']) owner(t, command);
    await until(() => of(t, 'sendMessage').length === 4);
    expect(of(t, 'sendMessage').map((m) => m.text)).toEqual([
      'Nothing runs now.\nNo approval waits for you.\nDashboard: https://okc-pc.example.ts.net',
      'No goals for today yet.',
      'No approval waits for you.',
      'https://okc-pc.example.ts.net',
    ]);
    expect(t.model.calls).toHaveLength(0);
    expect(listEvents(t.db, 'main')).toEqual([]);
  });

  it('shows the arguments of an approval in an expandable quote, and lists pending cards with /approvals', async () => {
    const t = setup([call('c1', 'notes__add_note', { note: 'buy milk & <eggs>', tags: ['home'] }), textStep('It waits for you.')], { integrations: true });
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    owner(t, 'add a note');
    await until(() => of(t, 'sendMessage').some((m) => m.parse_mode === 'HTML'));
    await t.app.idle();
    const card = of(t, 'sendMessage').find((m) => m.parse_mode === 'HTML')!;
    expect(String(card.text)).toMatch(/^Approval needed \(#1\): notes__add_note\nnote: "buy milk &amp; &lt;eggs&gt;"\ntags: \["home"\]\nWhy: /);
    expect(String(card.text)).toContain('<blockquote expandable>{\n  "note": "buy milk &amp; &lt;eggs&gt;",\n  "tags": [\n    "home"\n  ]\n}</blockquote>');
    // without a policy path, the card has no "always allow" button.
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: 'approval:1:approve' },
          { text: 'Deny', callback_data: 'approval:1:deny' },
        ],
      ],
    });

    owner(t, '/approvals');
    await until(() => of(t, 'sendMessage').filter((m) => m.parse_mode === 'HTML').length === 2);
    const listed = of(t, 'sendMessage').filter((m) => m.parse_mode === 'HTML')[1]!;
    expect(String(listed.text)).toMatch(/^This is the real request #1\./);
    expect(String(listed.text)).toContain('<blockquote expandable>');
  });

  it('adds an allow rule after a second button, approves the call, and the rule works in a clean session', async () => {
    const policyPath = join(mkdtempSync(join(tmpdir(), 'okc-policy-')), 'okc.policy.json');
    const t = setup(
      [
        call('c1', 'notes__add_note', { note: 'one' }),
        textStep('It waits for you.'),
        call('c2', 'notes__add_note', { note: 'two' }),
        textStep('It waits again, because the session read the notes server.'),
        call('c3', 'notes__add_note', { note: 'three' }),
        textStep('Saved.'),
      ],
      { integrations: true, policyPath },
    );
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');

    owner(t, 'add note one');
    await until(() => of(t, 'sendMessage').some((m) => m.parse_mode === 'HTML'));
    await t.app.idle();
    const card = of(t, 'sendMessage').find((m) => m.parse_mode === 'HTML')!;
    expect((card.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard[1]).toEqual([{ text: 'Always allow…', callback_data: 'approval:1:always' }]);

    // the first press only asks. nothing changes yet.
    press(t, 'approval:1:always');
    await until(() => of(t, 'sendMessage').some((m) => String(m.text).startsWith('Always allow notes__add_note?')));
    expect(t.rows('SELECT status FROM approvals')).toEqual([{ status: 'pending' }]);
    expect(() => readFileSync(policyPath, 'utf8')).toThrow();

    press(t, 'approval:1:always-yes');
    await until(() => of(t, 'sendMessage').some((m) => String(m.text).startsWith('notes__add_note is now always allowed.')));
    await t.app.idle();
    expect(JSON.parse(readFileSync(policyPath, 'utf8'))).toEqual({
      rules: [{ tool: 'notes__add_note', effect: 'allow', note: 'the owner allowed it from approval #1 on 2026-10-13' }],
    });
    expect(t.rows('SELECT status FROM approvals')).toEqual([{ status: 'approved' }]);
    expect(t.rows("SELECT output FROM tool_calls WHERE toolCallId = 'approval-1'")).toEqual([{ output: expect.stringContaining('saved: one') }]);

    // the result of the server tainted the session, so the next external call still asks.
    owner(t, 'add note two');
    await until(() => t.rows('SELECT id FROM approvals').length === 2);
    await t.app.idle();
    expect(t.rows("SELECT decision, rule FROM policy_decisions WHERE toolCallId = 'c2'")).toEqual([{ decision: 'approve', rule: 'taint' }]);

    // after /new the session is clean, and the rule allows the call without the owner.
    owner(t, '/new');
    owner(t, 'add note three');
    await until(() => of(t, 'sendRichMessage').some((m) => (m.rich_message as { markdown: string }).markdown === 'Saved.'));
    expect(t.rows("SELECT decision, rule FROM policy_decisions WHERE toolCallId = 'c3'")).toEqual([
      { decision: 'allow', rule: `${policyPath}#1` },
    ]);
    expect(t.rows('SELECT id FROM approvals')).toHaveLength(2);
  });
});
