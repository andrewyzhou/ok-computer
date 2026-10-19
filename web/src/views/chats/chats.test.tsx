// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatMessagesPage, ChatStreamEvent } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { chatRow, message } from './testdata';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

const CHATS = [
  chatRow(),
  chatRow({ key: 'main@40', title: 'what is next?', preview: 'Next is the essay check-in.', toEventId: null, pendingApprovals: 2, lastRunStatus: 'running' }),
];

// the stubs of the chat endpoints, with a transcript that a test can change.
function chatStubs(messages: ChatMessage[], extra: StubRoutes = {}) {
  const state = { messages, before: null as number | null };
  const routes: StubRoutes = {
    'GET /api/chats': ({ query }) => {
      const q = (query.get('q') ?? '').toLowerCase();
      return { chats: CHATS.filter((chat) => chat.title.includes(q) || (chat.preview ?? '').toLowerCase().includes(q)), nextCursor: null };
    },
    'GET /api/chats/:key/messages': ({ params }) => {
      const chat = CHATS.find((each) => each.key === params.key);
      if (!chat) return json({ error: 'chat not found' }, 404);
      const page: ChatMessagesPage = { chat, messages: state.messages, before: state.before };
      return page;
    },
    ...extra,
  };
  const calls = stubFetch(seeded.dashboard, routes);
  return { state, calls };
}

const chatStream = () => FakeEventSource.find('/api/chat/stream')!;
const emit = (event: ChatStreamEvent) => act(() => chatStream().emit(event));
const nav = () => within(screen.getByRole('navigation', { name: 'pages' }));

describe('the chats', () => {
  it('lists the main chats under the Chats heading of the nav and filters them by the nav search', async () => {
    const { calls } = chatStubs([message({ text: 'Saved your two goals.' })]);
    openApp('#/chats/main%400');
    const list = await nav().findByRole('list', { name: 'chats' });
    const section = list.closest('section')!;
    expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe('Chats');
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#/chats/main%400', '#/chats/main%4040']);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    expect(links[1]!.getAttribute('aria-current')).toBeNull();
    expect(within(links[1]!).getByText('running')).toBeTruthy();
    expect(within(links[1]!).getByLabelText('2 pending approvals')).toBeTruthy();

    fireEvent.change(nav().getByRole('searchbox'), { target: { value: 'next' } });
    await waitFor(() => expect(within(nav().getByRole('list', { name: 'chats' })).getAllByRole('link')).toHaveLength(1));
    expect(calls.some((call) => call.url === '/api/chats?kind=main&q=next&limit=30')).toBe(true);
    fireEvent.change(nav().getByRole('searchbox'), { target: { value: 'nothing like this' } });
    expect(await nav().findByText('No chat matches.')).toBeTruthy();
  });

  it('shows the transcript with its roles, and loads older messages', async () => {
    const newest = [
      message({ id: 20, role: 'owner', channel: 'telegram', text: 'my goals: essay by 21:00' }),
      message({ id: 21, role: 'note', guarded: true, text: 'the guard held a reply' }),
      message({ id: 22, role: 'system', text: 'session reset' }),
      message({ id: 23, role: 'agent', text: `a very long word ${'x'.repeat(400)}` }),
    ];
    const { state, calls } = chatStubs(newest);
    state.before = 20;
    openApp('#/chats/main%400');
    expect(await inMain().findByRole('heading', { level: 1, name: 'my goals: essay by 21:00' })).toBeTruthy();
    const log = inMain().getByRole('list', { name: 'transcript' });
    expect(within(log).getAllByTestId('chat-message')).toHaveLength(4);
    expect(within(log).getByText('on telegram')).toBeTruthy();
    expect(within(log).getByText('guard note')).toBeTruthy();

    // the older page answers the before of the newest page, and it is the first page of the chat.
    state.messages = [message({ id: 10, role: 'owner', text: 'an older message' })];
    state.before = null;
    fireEvent.click(inMain().getByRole('button', { name: 'Load older messages' }));
    expect(await within(log).findByText('an older message')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/chats/main%400/messages?limit=50&before=20')).toBe(true);
    expect(within(log).getAllByTestId('chat-message')[0]!.textContent).toContain('an older message');
    expect(inMain().queryByRole('button', { name: 'Load older messages' })).toBeNull();
    expect(inMain().getByText('This is the start of the chat.')).toBeTruthy();
  });

  it('sends a message and follows the turn from queued to the reply, then reloads the transcript', async () => {
    const { state, calls } = chatStubs([message({ id: 30, text: 'earlier reply' })], {
      'POST /api/chat': () => ({ turnId: 'web:t1', state: 'queued' }),
    });
    openApp('#/chats/main%400');
    await inMain().findByText('earlier reply');
    emit({ kind: 'snapshot', turns: [] });
    const box = inMain().getByRole('textbox', { name: 'Message' });
    const sendButton = inMain().getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'plan my evening' } });
    expect(sendButton.disabled).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });

    const turn = await inMain().findByTestId('chat-turn');
    expect(within(turn).getByText('plan my evening')).toBeTruthy();
    expect(within(turn).getByText('queued')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST' && call.url === '/api/chat')!.body).toEqual({ text: 'plan my evening' });
    expect((box as HTMLTextAreaElement).value).toBe('');

    emit({ kind: 'owner', turnId: 'web:t1', channel: 'web', text: 'plan my evening', at: '2026-10-13T02:00:00.000Z' });
    emit({ kind: 'state', turnId: 'web:t1', state: 'running' });
    emit({ kind: 'run', turnId: 'web:t1', runId: 'run-1' });
    emit({ kind: 'activity', turnId: 'web:t1', tools: 'goals_set' });
    emit({ kind: 'text', turnId: 'web:t1', delta: 'Thinking', reset: false });
    emit({ kind: 'text', turnId: 'web:t1', delta: 'Here is', reset: true });
    emit({ kind: 'text', turnId: 'web:t1', delta: ' the plan', reset: false });
    expect(within(turn).getByText('running')).toBeTruthy();
    expect(within(turn).getByText('using goals_set')).toBeTruthy();
    expect(within(turn).getByText('Here is the plan')).toBeTruthy();
    expect(within(turn).getByRole('link', { name: 'run run-1' }).getAttribute('href')).toBe('#/runs/run-1');
    // the text of another turn goes to its own block and never into this one.
    emit({ kind: 'text', turnId: 'web:other', delta: 'elsewhere', reset: false });
    expect(within(turn).queryByText(/elsewhere/)).toBeNull();
    expect(inMain().getAllByTestId('chat-turn')).toHaveLength(2);
    emit({ kind: 'done', turnId: 'web:other', ok: false });

    emit({
      kind: 'reply',
      turnId: 'web:t1',
      messageId: 'reply-1',
      runId: 'run-1',
      text: 'Essay at 19:00, gym at 20:30.',
      markdown: false,
      details: 'two goals checked',
      buttons: [[{ text: 'Looks good', data: 'plan:ok' }]],
      at: '2026-10-13T02:01:00.000Z',
    });
    expect(within(turn).getByText('Essay at 19:00, gym at 20:30.')).toBeTruthy();
    expect(within(turn).queryByText('Here is the plan')).toBeNull();
    fireEvent.click(within(turn).getByRole('button', { name: '▸ details' }));
    expect(within(turn).getByText('two goals checked')).toBeTruthy();

    state.messages = [
      message({ id: 30, text: 'earlier reply' }),
      message({ id: 31, role: 'owner', channel: 'web', text: 'plan my evening' }),
      message({ id: 32, runId: 'run-1', text: 'Essay at 19:00, gym at 20:30.' }),
    ];
    emit({ kind: 'state', turnId: 'web:t1', state: 'done' });
    emit({ kind: 'done', turnId: 'web:t1', ok: true });
    await waitFor(() => expect(inMain().queryByTestId('chat-turn')).toBeNull());
    expect(inMain().getAllByTestId('chat-message')).toHaveLength(3);
    expect(inMain().getAllByText('Essay at 19:00, gym at 20:30.')).toHaveLength(1);
  }, 20_000);

  it('stops a running turn, and says so when it already ended', async () => {
    const { calls } = chatStubs([], {
      'POST /api/chat': () => ({ turnId: 'web:t2', state: 'running' }),
      'POST /api/chat/stop': () => ({ stopped: false }),
    });
    openApp('#/chats/main%400');
    const box = await inMain().findByRole('textbox', { name: 'Message' });
    emit({ kind: 'snapshot', turns: [] });
    expect(inMain().getByText('No messages yet.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'a long task' } });
    fireEvent.click(inMain().getByRole('button', { name: 'Send' }));
    expect(await inMain().findByText('running')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Stop' }));
    expect(await inMain().findByText('the turn already ended')).toBeTruthy();
    expect(calls.find((call) => call.url === '/api/chat/stop')!.body).toEqual({ turnId: 'web:t2' });
    emit({ kind: 'state', turnId: 'web:t2', state: 'stopped' });
    expect(inMain().queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('stops the running turn when a follow-up waits in the queue', async () => {
    const { calls } = chatStubs([], { 'POST /api/chat/stop': () => ({ stopped: true }) });
    openApp('#/chats/main%400');
    await inMain().findByRole('textbox', { name: 'Message' });
    emit({
      kind: 'snapshot',
      turns: [
        { turnId: 'web:t3', channel: 'web', state: 'running', runId: null, text: 'working', activity: null },
        { turnId: 'web:t4', channel: 'web', state: 'queued', runId: null, text: '', activity: null },
      ],
    });
    expect(await inMain().findByText('working')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls.find((call) => call.url === '/api/chat/stop')?.body).toEqual({ turnId: 'web:t3' }));
    emit({ kind: 'snapshot', turns: [] });
  });

  it('says that a queued turn has not started when the server does not stop it', async () => {
    chatStubs([], { 'POST /api/chat/stop': () => ({ stopped: false }) });
    openApp('#/chats/main%400');
    await inMain().findByRole('textbox', { name: 'Message' });
    emit({ kind: 'snapshot', turns: [{ turnId: 'web:t5', channel: 'web', state: 'queued', runId: null, text: '', activity: null }] });
    fireEvent.click(await inMain().findByRole('button', { name: 'Stop' }));
    expect(await inMain().findByText('the turn has not started yet. it can be stopped once it runs')).toBeTruthy();
    emit({ kind: 'snapshot', turns: [] });
  });

  it('shows that the web channel is not running, and keeps the draft', async () => {
    chatStubs([], { 'POST /api/chat': () => json({ error: 'the web channel is not running' }, 503) });
    openApp('#/chats/main%400');
    const box = await inMain().findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'are you there?' } });
    fireEvent.click(inMain().getByRole('button', { name: 'Send' }));
    expect((await inMain().findByRole('alert')).textContent).toBe('the web channel is not running');
    expect((box as HTMLTextAreaElement).value).toBe('are you there?');
    expect(inMain().queryByTestId('chat-turn')).toBeNull();
  });

  it('shows a telegram turn live, and a reply with no turn with its buttons', async () => {
    const { calls } = chatStubs([], { 'POST /api/chat/button': () => ({ ok: true }) });
    openApp('#/chats/main%400');
    await inMain().findByRole('textbox', { name: 'Message' });
    emit({ kind: 'snapshot', turns: [{ turnId: 'telegram:77', channel: 'telegram', state: 'running', runId: null, text: 'half', activity: null }] });
    expect(await inMain().findByText('half')).toBeTruthy();
    emit({
      kind: 'reply',
      turnId: null,
      messageId: 'card-1',
      runId: null,
      text: 'Send the email to Sam?',
      markdown: false,
      details: null,
      buttons: [[{ text: 'Approve', data: 'approval:9:approve' }]],
      at: '2026-10-13T02:00:00.000Z',
    });
    const card = inMain().getByTestId('chat-standalone');
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await within(card).findByText('Approve: sent')).toBeTruthy();
    expect(calls.find((call) => call.url === '/api/chat/button')!.body).toEqual({ data: 'approval:9:approve' });
  });

  it('shows the approval of a message inline and approves it', async () => {
    chatStubs([message({ id: 40, role: 'note', text: 'the agent asks to run now', approvalId: seeded.pendingApprovalId })]);
    openApp('#/chats/main%400');
    const card = await inMain().findByRole('article', { name: `approval #${seeded.pendingApprovalId}` });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull());
    expect(seeded.t.rows(`SELECT status FROM approvals WHERE id = ${seeded.pendingApprovalId}`)).toEqual([{ status: 'approved' }]);
  });

  it('shows tool chips that expand only in developer mode, and the trace link only in developer mode', async () => {
    chatStubs([message({ id: 50, runId: 'run-1', text: 'Saved your two goals.' })]);
    openApp('#/chats/main%400');
    const chips = await inMain().findByRole('list', { name: 'tools used' });
    expect(within(chips).getByText('goals_set')).toBeTruthy();
    expect(within(chips).queryAllByRole('button')).toHaveLength(0);
    expect(inMain().getByRole('link', { name: 'run run-1' })).toBeTruthy();
    expect(inMain().queryByRole('link', { name: 'trace of run run-1' })).toBeNull();

    act(() => setPrefs({ devMode: true }));
    expect(inMain().getByRole('link', { name: 'trace of run run-1' }).getAttribute('href')).toBe('#/trace/run-1');
    const chip = within(chips).getByRole('button', { name: /goals_set/ });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    const detail = inMain().getByRole('group', { name: 'tool call goals_set' });
    expect(detail.textContent).toContain('finish essay');
    expect(within(detail).getByText('output')).toBeTruthy();

    // developer mode off closes the chip again.
    act(() => setPrefs({ devMode: false }));
    expect(inMain().queryByRole('group', { name: 'tool call goals_set' })).toBeNull();
  });

  it('shows the facts and the token estimate of the next request in the details panel', async () => {
    chatStubs([message({ id: 60, text: 'hi' })]);
    setPrefs({ devMode: true });
    openApp('#/chats/main%400');
    await inMain().findByText('hi');
    const details = screen.getByRole('heading', { level: 2, name: 'Chat' }).closest('.details-inner') as HTMLElement;
    expect(await within(details).findByText(/tokens, estimated/)).toBeTruthy();
    expect(within(details).getByText('$0.01')).toBeTruthy();
    expect(within(details).getByRole('link', { name: 'main' }).getAttribute('href')).toBe('#/sessions/main');
    expect(within(details).getByText('Chat stream')).toBeTruthy();
  });

  it('opens the newest main chat from the Chats item', async () => {
    chatStubs([message({ id: 70, text: 'the newest chat' })]);
    openApp('#/chats');
    expect(await inMain().findByText('the newest chat')).toBeTruthy();
    expect(inMain().getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });

  it('shows an older segment read-only, and a chat that does not exist', async () => {
    CHATS.push(chatRow({ key: 'main@5', title: 'an old chat', toEventId: 39 }));
    try {
      chatStubs([message({ id: 80, text: 'old text' })]);
      openApp('#/chats/main%405');
      expect(await inMain().findByText('old text')).toBeTruthy();
      expect(inMain().queryByRole('textbox', { name: 'Message' })).toBeNull();
      expect(inMain().getByText(/read-only/)).toBeTruthy();
      cleanup();
      openApp('#/chats/main%40999');
      expect(await inMain().findByText('This chat does not exist.')).toBeTruthy();
      expect(inMain().getByText('chat not found')).toBeTruthy();
    } finally {
      CHATS.pop();
    }
  });
});
