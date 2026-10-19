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
    // the web chat gets a copy, so an open tab shows the alert too.
    expect(sent.map(([id, out]) => `${id} ${out.chatId}`)).toEqual(['telegram 777', 'web web']);
  });

  it('copies each proactive message to the web chat with its buttons and no replyTo, and keeps the result of the target', async () => {
    const sent: Array<[string, OutboundMessage]> = [];
    const db = openDb(':memory:');
    const failingWeb: ChannelAdapter = {
      ...channel('web', sent),
      send: async () => {
        throw new Error('the web chat failed');
      },
    };
    const buttons = [[{ text: 'Approve', data: 'approval:1:approve' }]];
    const preferred = { channel: 'telegram', chatId: '777' };
    const owner = createOwnerMessenger({
      db,
      channels: new Map([
        ['telegram', channel('telegram', sent)],
        ['web', channel('web', sent)],
      ]),
      logger: silentLogger,
      clock: () => new Date(),
      preferred,
    });
    expect(await owner.send('Approval needed (#1)', buttons, { runId: 'r1' })).toBe(true);
    expect(sent).toEqual([
      ['telegram', { chatId: '777', text: 'Approval needed (#1)', buttons, runId: 'r1' }],
      ['web', { chatId: 'web', text: 'Approval needed (#1)', buttons, runId: 'r1' }],
    ]);

    const broken = createOwnerMessenger({
      db,
      channels: new Map([
        ['telegram', channel('telegram', sent)],
        ['web', failingWeb],
      ]),
      logger: silentLogger,
      clock: () => new Date(),
      preferred,
    });
    expect(await broken.send('still sent')).toBe(true);
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
    // the copy reaches the web chat, but no chat that must deliver it is known.
    expect(await owner.send('lost')).toBe(false);
    expect(sent).toEqual([['web', { chatId: 'web', text: 'lost' }]]);
  });
});
