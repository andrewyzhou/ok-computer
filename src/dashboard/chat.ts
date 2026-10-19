import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { DashboardDeps } from './server.js';
import type { ChatButtonResponse, ChatSendResponse, ChatStopResponse, ChatStreamEvent } from './types.js';

// phase 5 m2 owns this module. it mounts POST /api/chat, POST /api/chat/button, POST /api/chat/stop and
// GET /api/chat/stream. docs/PHASE5-API.md gives the shapes and the errors. server.ts calls it after the sign-in
// check, so each route is behind the dashboard auth.
// the chat stream sends event: ping this often, so a proxy or the browser does not close a quiet stream.
export const CHAT_PING_MS = 25_000;
// a client that is this many events behind gets its stream closed. the page then connects again and gets a fresh
// snapshot, so the server never holds an endless queue for a slow client.
export const CHAT_MAX_PENDING = 1_000;

const sendBody = z.object({ text: z.string().min(1).max(16_000) }).strict();
const buttonBody = z.object({ data: z.string().min(1).max(256), turnId: z.string().min(1).max(200).optional() }).strict();
const stopBody = z.object({ turnId: z.string().min(1).max(200) }).strict();

const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
};
const notRunning = (c: Context) => c.json({ error: 'the web chat is not running' }, 503);

export function mountChat(server: Hono, deps: DashboardDeps): void {
  // the chat is read on each request, so a channel that starts or stops later is seen.
  const running = () => {
    const chat = deps.app.chat;
    return chat?.running() ? chat : undefined;
  };

  // the text goes to the router unchanged. a text of only spaces is not a message.
  server.post('/api/chat', async (c) => {
    const input = await body(c, sendBody);
    if (!input || input.text.trim() === '') return c.json({ error: 'give a text of 1 to 16,000 characters' }, 400);
    const chat = running();
    if (!chat) return notRunning(c);
    const sent = chat.submit(input.text);
    if (!sent) return notRunning(c);
    return c.json(sent satisfies ChatSendResponse);
  });

  // the data of a button goes to the router like a pressed telegram button. it never goes to the model.
  server.post('/api/chat/button', async (c) => {
    const input = await body(c, buttonBody);
    if (!input) return c.json({ error: 'give the data of a button' }, 400);
    const chat = running();
    if (!chat || !chat.press(input.data, input.turnId)) return notRunning(c);
    return c.json({ ok: true } satisfies ChatButtonResponse);
  });

  // this is the same path as /stop. it calls the stop callback of the progress of the turn.
  server.post('/api/chat/stop', async (c) => {
    const input = await body(c, stopBody);
    if (!input) return c.json({ error: 'give the turnId of the turn to stop' }, 400);
    const chat = running();
    if (!chat) return notRunning(c);
    return c.json({ stopped: chat.stop(input.turnId) } satisfies ChatStopResponse);
  });

  server.get('/api/chat/stream', (c) => {
    const chat = running();
    if (!chat) return notRunning(c);
    return streamSSE(c, async (stream) => {
      const pending: ChatStreamEvent[] = [];
      let ping = false;
      let ended = false;
      let wake: (() => void) | undefined;
      const signal = () => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
      };
      const end = () => {
        ended = true;
        signal();
      };
      // the snapshot and the subscription are taken with no await between them, so each later event comes once and
      // none is lost.
      const turns = chat.snapshot();
      const unsubscribe = chat.subscribe((event) => {
        if (ended) return;
        pending.push(event);
        if (pending.length > CHAT_MAX_PENDING) end();
        else signal();
      });
      const timer = setInterval(() => {
        ping = true;
        signal();
      }, CHAT_PING_MS);
      stream.onAbort(end);
      // one loop does every write, so two events never interleave on the wire. a write that fails marks the stream
      // as aborted, and the loop then ends.
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        await stream.writeSSE({ data: JSON.stringify({ kind: 'snapshot', turns } satisfies ChatStreamEvent) });
        while (!ended && !stream.aborted) {
          if (ping) {
            ping = false;
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
          const event = pending.shift();
          if (event) {
            await stream.writeSSE({ data: JSON.stringify(event) });
            continue;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        ended = true;
        unsubscribe();
        clearInterval(timer);
      }
    });
  });
}
