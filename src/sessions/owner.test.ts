import { describe, expect, it } from 'vitest';
import type { ChannelAdapter, OutboundMessage } from '../channels/types.js';
import { openDb } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
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

  it('prefers the owner telegram chat to the cli, and the last chat of another channel to both', async () => {
    const sent: Array<[string, OutboundMessage]> = [];
    const db = openDb(':memory:');
    const channels = new Map([
      ['cli', channel('cli', sent)],
      ['telegram', channel('telegram', sent)],
    ]);
    const preferred = { channel: 'telegram', chatId: '777' };
    const owner = createOwnerMessenger({ db, channels, logger: silentLogger, clock: () => new Date(), preferred });
    await owner.send('before any message');
    owner.remember({ channel: 'cli', chatId: 'local' });
    await owner.send('after a cli message');
    owner.remember({ channel: 'telegram', chatId: '-100' });
    await owner.send('after a group message');
    expect(sent.map(([id, out]) => `${id} ${out.chatId}`)).toEqual(['telegram 777', 'telegram 777', 'telegram -100']);
  });

  it('gives false when no chat is known', async () => {
    const owner = createOwnerMessenger({ db: openDb(':memory:'), channels: new Map(), logger: silentLogger, clock: () => new Date() });
    expect(await owner.send('lost')).toBe(false);
  });

  // the web chat shows only while a tab of the dashboard is open, so an approval card sent there could wait unseen.
  it('keeps the saved telegram chat when the owner writes on the web', async () => {
    const sent: Array<[string, OutboundMessage]> = [];
    const db = openDb(':memory:');
    const channels = new Map([
      ['telegram', channel('telegram', sent)],
      ['web', channel('web', sent)],
    ]);
    const owner = createOwnerMessenger({ db, channels, logger: silentLogger, clock: () => new Date() });
    owner.remember({ channel: 'telegram', chatId: '777' });
    owner.remember({ channel: 'web', chatId: 'web' });
    expect(getSetting(db, 'owner_chat')).toEqual({ channel: 'telegram', chatId: '777' });
    await owner.send('alert');
    expect(sent.map(([id, out]) => `${id} ${out.chatId}`)).toEqual(['telegram 777']);
  });

  it('skips an old saved web chat for the preferred chat, and then for the cli', () => {
    const db = openDb(':memory:');
    setSetting(db, 'owner_chat', { channel: 'web', chatId: 'web' }, new Date());
    const sent: Array<[string, OutboundMessage]> = [];
    const preferred = { channel: 'telegram', chatId: '777' };
    const all = new Map([
      ['cli', channel('cli', sent)],
      ['telegram', channel('telegram', sent)],
      ['web', channel('web', sent)],
    ]);
    expect(createOwnerMessenger({ db, channels: all, logger: silentLogger, clock: () => new Date(), preferred }).chat()).toEqual(preferred);
    all.delete('telegram');
    expect(createOwnerMessenger({ db, channels: all, logger: silentLogger, clock: () => new Date(), preferred }).chat()).toEqual({ channel: 'cli', chatId: 'local' });
  });

  it('knows no chat when only the web channel runs', async () => {
    const db = openDb(':memory:');
    const sent: Array<[string, OutboundMessage]> = [];
    const owner = createOwnerMessenger({ db, channels: new Map([['web', channel('web', sent)]]), logger: silentLogger, clock: () => new Date() });
    owner.remember({ channel: 'web', chatId: 'web' });
    expect(owner.chat()).toBeUndefined();
    expect(await owner.send('lost')).toBe(false);
    expect(sent).toEqual([]);
  });
});
