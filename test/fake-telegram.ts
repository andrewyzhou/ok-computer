import { Bot, type Transformer } from 'grammy';
import type { Update } from 'grammy/types';

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const person = (id: number) => ({ id, is_bot: false, first_name: `user${id}` });
const privateChat = (id: number) => ({ id, type: 'private' as const, first_name: `user${id}` });

export function textUpdate(from: number, text: string, chat = from): Omit<Update, 'update_id'> {
  return { message: { message_id: 1, date: 0, chat: privateChat(chat), from: person(from), text } } as Omit<Update, 'update_id'>;
}

export function buttonUpdate(from: number, data: string, chat = from): Omit<Update, 'update_id'> {
  return {
    callback_query: {
      id: `cb-${data}`,
      from: person(from),
      chat_instance: 'ci',
      data,
      message: { message_id: 9, date: 0, chat: privateChat(chat), text: 'Approval needed' },
    },
  } as Omit<Update, 'update_id'>;
}

export function stopUpdate(chat: number, draftId: number): Omit<Update, 'update_id'> {
  return { stopped_message_generation: { chat: privateChat(chat), draft_id: draftId } } as Omit<Update, 'update_id'>;
}

// the fake bot api answers every call in memory. getUpdates gives the pushed updates and waits for more until
// polling stops, so tests drive the real long polling loop without a network. a test can make telegram refuse a
// format: a call that refuse() names gets a 400, as telegram gives for markdown or html that it cannot parse.
export function createFakeTelegram() {
  const calls: ApiCall[] = [];
  const updates: Update[] = [];
  let nextUpdateId = 1;
  let nextMessageId = 100;
  let wake: (() => void) | undefined;
  // the rule gives the error code of a refused call, or false.
  let refuse: (call: ApiCall) => number | false = () => false;

  const transformer: Transformer = async (_prev, method, payload, signal) => {
    const body = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: body });
    const ok = (result: unknown) => ({ ok: true as const, result }) as never;
    const code = refuse({ method, payload: body });
    if (code) return { ok: false as const, error_code: code, description: code === 400 ? "Bad Request: can't parse entities" : 'Internal Server Error' } as never;
    switch (method) {
      case 'sendRichMessage':
        return ok({ message_id: nextMessageId++, date: 0, chat: { id: Number(body.chat_id), type: 'private' } });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        while (!updates.some((u) => u.update_id >= offset)) {
          if (!signal) return ok([]);
          if (signal.aborted) throw new Error('polling stopped');
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return ok(updates.filter((u) => u.update_id >= offset));
      }
      case 'sendMessage':
        return ok({ message_id: nextMessageId++, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text });
      default:
        return ok(true);
    }
  };

  const bot = new Bot('123456:TEST-TOKEN', {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'okc',
      username: 'okc_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as Bot['botInfo'],
  });
  bot.api.config.use(transformer);

  return {
    bot,
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload),
    // the messages that reached the chat in order, plain or rich.
    messages: () =>
      calls
        .filter((c) => c.method === 'sendMessage' || c.method === 'sendRichMessage')
        .map((c) => ({ chatId: String(c.payload.chat_id), text: String(c.payload.text ?? (c.payload.rich_message as { markdown: string }).markdown) })),
    refuse(rule: (call: ApiCall) => number | false) {
      refuse = rule;
    },
    push(update: Omit<Update, 'update_id'>) {
      updates.push({ ...update, update_id: nextUpdateId++ } as Update);
      wake?.();
    },
  };
}

// polling and the handlers take a few turns of the event loop. the helper waits for a condition and never sleeps.
export async function until(condition: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the condition did not become true');
}
