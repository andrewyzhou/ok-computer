// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { subscribe } from './api';
import { subscribeChat } from './chat-stream';
import { FakeEventSource, installEventSource } from './testing';

// both shared streams close on pagehide, so the browser can keep the page in its back and forward cache. when the
// page comes back from that cache, each stream must open again for the parts that still listen.

installEventSource();

it('opens both streams again when the page comes back from the back and forward cache', () => {
  const stop = subscribe(() => {});
  const stopChat = subscribeChat(() => {});
  const main = FakeEventSource.find('/api/stream')!;
  const chat = FakeEventSource.find('/api/chat/stream')!;
  dispatchEvent(new Event('pagehide'));
  expect(main.readyState).toBe(2);
  expect(chat.readyState).toBe(2);
  const back = new Event('pageshow') as Event & { persisted: boolean };
  Object.defineProperty(back, 'persisted', { value: true });
  dispatchEvent(back);
  expect(FakeEventSource.find('/api/stream')).not.toBe(main);
  expect(FakeEventSource.find('/api/chat/stream')).not.toBe(chat);
  expect(FakeEventSource.find('/api/stream')!.readyState).toBe(1);
  stop();
  stopChat();
});
