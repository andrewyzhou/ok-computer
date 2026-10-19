// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatMessagesPage, ChatStreamEvent } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { applyTurnAction, turnsReducer, type TurnAction, type Turns } from '../../chat-stream';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { MAX_TEXT } from './Composer';
import { chatHref, messagesPath } from './data';
import { chatRow, message } from './testdata';

// the failure paths of the chat: the limits of the composer, a stream that sends bad data or events out of order, and
// a transcript that fails to load again.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
  // the live turns are module state, so each test starts with none.
  act(() => applyTurnAction({ kind: 'snapshot', turns: [] }));
});
afterEach(() => cleanup());

const CHAT = chatRow();

function chatStubs(messages: ChatMessage[], extra: StubRoutes = {}) {
  const state = { messages, fail: false };
  const routes: StubRoutes = {
    'GET /api/chats': () => ({ chats: [CHAT], nextCursor: null }),
    'GET /api/chats/:key/messages': ({ params }) => {
      if (params.key !== CHAT.key) return json({ error: 'chat not found' }, 404);
      if (state.fail) return json({ error: 'the database is busy' }, 500);
      const page: ChatMessagesPage = { chat: CHAT, messages: state.messages, before: null };
      return page;
    },
    ...extra,
  };
  const calls = stubFetch(seeded.dashboard, routes);
  return { state, calls };
}

const chatStream = () => FakeEventSource.find('/api/chat/stream')!;
const emit = (event: ChatStreamEvent) => act(() => chatStream().emit(event));

describe('the composer limits', () => {
  it('sends exactly the limit, refuses one more, and refuses only spaces', async () => {
    const { calls } = chatStubs([], { 'POST /api/chat': () => ({ turnId: 'web:limit', state: 'running' }) });
    openApp('#/chats/main%400');
    const box = (await inMain().findByRole('textbox', { name: 'Message' })) as HTMLTextAreaElement;
    const sendButton = inMain().getByRole('button', { name: 'Send' }) as HTMLButtonElement;

    fireEvent.change(box, { target: { value: '   \n\t ' } });
    expect(sendButton.disabled).toBe(true);
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.change(box, { target: { value: 'x'.repeat(MAX_TEXT + 1) } });
    expect(sendButton.disabled).toBe(true);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(inMain().getByText(/too long to send/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/chat')).toBe(false);

    fireEvent.change(box, { target: { value: 'x'.repeat(MAX_TEXT) } });
    expect(sendButton.disabled).toBe(false);
    expect(box.getAttribute('aria-invalid')).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe(''));
    const sent = calls.filter((call) => call.method === 'POST' && call.url === '/api/chat');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { text: string }).text).toHaveLength(MAX_TEXT);
  });

  it('adds a line with Shift+Enter, and sends one request for a double Enter', async () => {
    let release: () => void = () => {};
    const { calls } = chatStubs([], {
      'POST /api/chat': () =>
        new Promise((resolve) => {
          release = () => resolve(json({ turnId: 'web:double', state: 'queued' }));
        }),
    });
    openApp('#/chats/main%400');
    const box = (await inMain().findByRole('textbox', { name: 'Message' })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'one line' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(calls.some((call) => call.url === '/api/chat')).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(inMain().getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/chat')).toHaveLength(1));
    await act(async () => release());
    await waitFor(() => expect(box.value).toBe(''));
    expect(calls.filter((call) => call.url === '/api/chat')).toHaveLength(1);
  });

  it('shows the error of a failed stop as an alert', async () => {
    chatStubs([], {
      'POST /api/chat': () => ({ turnId: 'web:stopfail', state: 'running' }),
      'POST /api/chat/stop': () => json({ error: 'the turn could not stop' }, 500),
    });
    openApp('#/chats/main%400');
    const box = await inMain().findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'work' } });
    fireEvent.click(inMain().getByRole('button', { name: 'Send' }));
    fireEvent.click(await inMain().findByRole('button', { name: 'Stop' }));
    expect((await inMain().findByRole('alert')).textContent).toBe('the turn could not stop');
  });
});

describe('a stream that misbehaves', () => {
  it('ignores a message that is not json, a kind it does not know and a named ping', async () => {
    chatStubs([message({ id: 1, text: 'the transcript' })]);
    openApp('#/chats/main%400');
    await inMain().findByText('the transcript');
    act(() => {
      chatStream().onmessage?.({ data: 'not json {' });
      chatStream().onmessage?.({ data: 'null' });
      chatStream().emit({ kind: 'telemetry', turnId: 'web:x' });
      chatStream().emitNamed('ping');
    });
    expect(inMain().queryByTestId('chat-turn')).toBeNull();
    expect(inMain().getByText('the transcript')).toBeTruthy();
  });

  it('shows text that comes before the owner message, from a turn the page did not start', async () => {
    chatStubs([]);
    openApp('#/chats/main%400');
    await inMain().findByRole('textbox', { name: 'Message' });
    emit({ kind: 'text', turnId: 'telegram:5', delta: 'early words', reset: false });
    const turn = await inMain().findByTestId('chat-turn');
    expect(within(turn).getByText('early words')).toBeTruthy();
    emit({ kind: 'owner', turnId: 'telegram:5', channel: 'telegram', text: 'from the phone', at: '2026-10-13T02:00:00.000Z' });
    expect(within(turn).getByText('from the phone')).toBeTruthy();
    expect(within(turn).getByText('on telegram')).toBeTruthy();
  });

  it('never shows live turns in a chat that ended with a reset', async () => {
    const old = chatRow({ key: 'main@9', toEventId: 20, title: 'an ended chat' });
    stubFetch(seeded.dashboard, {
      'GET /api/chats': () => ({ chats: [old], nextCursor: null }),
      'GET /api/chats/:key/messages': () => ({ chat: old, messages: [message({ id: 2, text: 'old words' })], before: null }),
    });
    openApp('#/chats/main%409');
    await inMain().findByText('old words');
    emit({ kind: 'owner', turnId: 'web:live', channel: 'web', text: 'a new message', at: '2026-10-13T02:00:00.000Z' });
    emit({ kind: 'state', turnId: 'web:live', state: 'running' });
    expect(inMain().queryByTestId('chat-turn')).toBeNull();
    expect(inMain().queryByRole('textbox', { name: 'Message' })).toBeNull();
  });
});

describe('the links and paths of a chat', () => {
  it('encodes each part of a chat key', () => {
    expect(chatHref('main@0')).toBe('#/chats/main%400');
    expect(chatHref('auto:daily brief/1', 'activity')).toBe('#/activity/auto%3Adaily%20brief%2F1');
    expect(messagesPath('sub:a?b', 12)).toBe('/api/chats/sub%3Aa%3Fb/messages?limit=50&before=12');
    expect(messagesPath('main@0')).toBe('/api/chats/main%400/messages?limit=50');
  });
});

describe('the reducer with events out of order', () => {
  const run = (events: TurnAction[], start: Turns = new Map()) => events.reduce(turnsReducer, start);

  it('keeps running when the post answer queued comes after the stream said running', () => {
    const turns = run([
      { kind: 'state', turnId: 'web:r', state: 'running' },
      { kind: 'sent', turnId: 'web:r', text: 'hi', state: 'queued' },
    ]);
    expect(turns.get('web:r')?.state).toBe('running');
    expect(turns.get('web:r')?.ownerText).toBe('hi');
  });

  it('keeps a failed turn failed when a late done ok false comes', () => {
    const turns = run([
      { kind: 'state', turnId: 'web:f', state: 'running' },
      { kind: 'state', turnId: 'web:f', state: 'failed' },
      { kind: 'done', turnId: 'web:f', ok: false },
    ]);
    expect(turns.get('web:f')?.state).toBe('failed');
    expect(turns.get('web:f')?.activity).toBeNull();
  });

  it('drops the streamed text and the activity when the reply comes', () => {
    const turns = run([
      { kind: 'state', turnId: 'web:t', state: 'running' },
      { kind: 'activity', turnId: 'web:t', tools: 'web_search' },
      { kind: 'text', turnId: 'web:t', delta: 'draft', reset: false },
      { kind: 'reply', turnId: 'web:t', messageId: 'm', runId: 'run-3', text: 'final', markdown: true, details: null, buttons: [], at: '2026-10-13T02:00:00.000Z' },
    ]);
    expect(turns.get('web:t')).toMatchObject({ text: '', activity: null, runId: 'run-3', reply: { text: 'final', markdown: true } });
  });

  it('leaves the state alone for an error or a reply with no turn', () => {
    const start = run([{ kind: 'state', turnId: 'web:e', state: 'running' }]);
    expect(run([{ kind: 'error', turnId: null, error: 'boom' }], start)).toBe(start);
    expect(run([{ kind: 'done', turnId: 'web:unknown', ok: true }], start)).toBe(start);
    expect(run([{ kind: 'drop', turnIds: ['web:unknown'] }], start)).toBe(start);
  });
});
