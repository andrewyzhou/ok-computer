import { describe, expect, it } from 'vitest';
import type { GoogleAccounts, GoogleApis } from '../google/accounts.js';
import { READ_CALLS, ReadOnlyRefused, readOnlyApis, readOnlyGoogle } from './readonly.js';

// a stand-in of the sdk clients: each method records its path and the object it ran on.
function fakeApis(calls: string[]): GoogleApis {
  const method = (path: string) =>
    function (this: unknown, ...args: unknown[]) {
      calls.push(path);
      return Promise.resolve({ data: { path, self: this !== undefined, args } });
    };
  const gmail = {
    context: { secret: 1 },
    users: {
      getProfile: method('gmail.users.getProfile'),
      messages: { list: method('list'), get: method('get'), modify: method('modify'), batchModify: method('batchModify'), trash: method('trash'), send: method('send') },
      drafts: { create: method('drafts.create'), list: method('drafts.list'), send: method('drafts.send') },
      labels: { list: method('labels.list'), create: method('labels.create') },
    },
  };
  const calendar = { events: { list: method('events.list'), insert: method('events.insert'), delete: method('events.delete') } };
  return { gmail, calendar } as unknown as GoogleApis;
}

describe('readOnlyApis', () => {
  it('runs the read calls on the real object', async () => {
    const calls: string[] = [];
    const apis = readOnlyApis(fakeApis(calls));
    const listed = (await apis.gmail.users.messages.list({ userId: 'me' })) as unknown as { data: { self: boolean } };
    expect(listed.data.self).toBe(true);
    await apis.gmail.users.messages.get({ userId: 'me', id: 'x' });
    await apis.gmail.users.labels.list({ userId: 'me' });
    await apis.gmail.users.drafts.list({ userId: 'me' });
    await apis.calendar.events.list({ calendarId: 'primary' });
    expect(calls).toEqual(['list', 'get', 'labels.list', 'drafts.list', 'events.list']);
  });

  it('refuses every call that could change an account before it runs', () => {
    const calls: string[] = [];
    const refused: string[] = [];
    const apis = readOnlyApis(fakeApis(calls), refused) as unknown as Record<string, Record<string, Record<string, Record<string, (...args: unknown[]) => unknown>>>>;
    const tries: Array<() => unknown> = [
      () => apis.gmail!.users!.messages!.modify!({}),
      () => apis.gmail!.users!.messages!.batchModify!({}),
      () => apis.gmail!.users!.messages!.trash!({}),
      () => apis.gmail!.users!.messages!.send!({}),
      () => apis.gmail!.users!.drafts!.create!({}),
      () => apis.gmail!.users!.drafts!.send!({}),
      () => apis.gmail!.users!.labels!.create!({}),
      () => (apis.calendar as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>).events!.insert!({}),
      () => (apis.calendar as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>).events!.delete!({}),
    ];
    for (const each of tries) expect(each).toThrow(ReadOnlyRefused);
    expect(calls).toEqual([]);
    expect(refused).toEqual([
      'gmail.users.messages.modify',
      'gmail.users.messages.batchModify',
      'gmail.users.messages.trash',
      'gmail.users.messages.send',
      'gmail.users.drafts.create',
      'gmail.users.drafts.send',
      'gmail.users.labels.create',
      'calendar.events.insert',
      'calendar.events.delete',
    ]);
  });

  it('refuses a change of the client objects', () => {
    const apis = readOnlyApis(fakeApis([])) as unknown as { gmail: { users: Record<string, unknown> } };
    expect(() => {
      apis.gmail.users.messages = {};
    }).toThrow(ReadOnlyRefused);
  });

  it('works on clients whose objects cannot be written or configured, as in the sdk', async () => {
    const calls: string[] = [];
    const messages = Object.freeze({
      list: function (this: unknown) {
        calls.push('list');
        return Promise.resolve({ data: { self: this === messages } });
      },
      modify: () => calls.push('modify'),
    });
    const users = {};
    Object.defineProperty(users, 'messages', { value: messages, writable: false, configurable: false, enumerable: true });
    const gmail = {};
    Object.defineProperty(gmail, 'users', { value: users, writable: false, configurable: false, enumerable: true });
    const real = { gmail: Object.freeze(gmail), calendar: Object.freeze({ events: Object.freeze({ list: () => Promise.resolve({}) }) }) };
    const apis = readOnlyApis(real as unknown as GoogleApis);
    const listed = (await apis.gmail.users.messages.list({ userId: 'me' })) as unknown as { data: { self: boolean } };
    expect(listed.data.self).toBe(true);
    expect('messages' in apis.gmail.users).toBe(true);
    expect(() => apis.gmail.users.messages.modify({ userId: 'me', id: 'x' })).toThrow(ReadOnlyRefused);
    expect(calls).toEqual(['list']);
  });

  it('lists only calls that read', () => {
    for (const call of READ_CALLS) expect(call).toMatch(/\.(list|get|getProfile|query)$/);
  });
});

describe('readOnlyGoogle', () => {
  it('gives the job the guarded apis, refuses a one-click post and the sign-in calls', async () => {
    const calls: string[] = [];
    const real = fakeApis(calls);
    const accounts = {
      aliases: ['a06', 'school'],
      unavailable: (alias: string) => (alias === 'school' ? 'school needs a sign-in' : undefined),
      run: <T>(_alias: string, fn: (apis: GoogleApis) => Promise<T>) => fn(real),
      hasClient: async () => true,
      close: async () => {},
    } as unknown as GoogleAccounts;
    const google = readOnlyGoogle(accounts);
    expect(google.accounts.aliases).toEqual(['a06', 'school']);
    expect(google.accounts.unavailable('school')).toBe('school needs a sign-in');
    await expect(google.accounts.run('a06', (apis) => apis.gmail.users.messages.modify({ userId: 'me', id: 'x' }))).rejects.toThrow(ReadOnlyRefused);
    await google.accounts.run('a06', (apis) => apis.gmail.users.messages.list({ userId: 'me' }));
    expect(await google.oneClick('https://x.example/u')).toMatchObject({ ok: false, sent: false, refused: true });
    await expect(google.accounts.beginSignIn('a06')).rejects.toThrow(ReadOnlyRefused);
    await expect(google.accounts.importToken('a06', { refreshToken: 'r', clientId: 'c' })).rejects.toThrow(ReadOnlyRefused);
    expect(calls).toEqual(['list']);
    expect(google.refused).toEqual(['gmail.users.messages.modify', 'oneClick https://x.example/u', 'beginSignIn', 'importToken']);
  });
});
