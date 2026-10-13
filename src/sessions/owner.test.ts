import { describe, expect, it } from 'vitest';
import type { ChannelAdapter, OutboundMessage } from '../channels/types.js';
import { openDb } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { createOwnerMessenger } from './owner.js';

function channel(id: string, sent: Array<[string, OutboundMessage]>): ChannelAdapter {
  return {
    id,
    start: async () => {},
    stop: async () => {},
    send: async (out) => {
      sent.push([id, out]);
      return { messageId: '1' };
    },
  };
}

describe('owner messenger', () => {
  it('sends to the cli first and then to the chat that the owner used last', async () => {
    const sent: Array<[string, OutboundMessage]> = [];
    const db = openDb(':memory:');
    const channels = new Map([
      ['cli', channel('cli', sent)],
      ['other', channel('other', sent)],
    ]);
    const owner = createOwnerMessenger({ db, channels, logger: silentLogger, clock: () => new Date() });
    await owner.send('one');
    owner.remember({ channel: 'other', chatId: '42' });
    await owner.send('two');
    expect(sent).toEqual([
      ['cli', { chatId: 'local', text: 'one' }],
      ['other', { chatId: '42', text: 'two' }],
    ]);
  });

  it('gives false when no chat is known', async () => {
    const owner = createOwnerMessenger({ db: openDb(':memory:'), channels: new Map(), logger: silentLogger, clock: () => new Date() });
    expect(await owner.send('lost')).toBe(false);
  });
});
