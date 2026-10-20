import { describe, expect, it } from 'vitest';
import type { GoogleApis } from '../google/accounts.js';
import { ReadOnlyRefused, readOnlyApis } from './readonly.js';

// tests that try to get a write call past the read-only view of the quality check: through call, apply and bind, a
// method taken out of its object, a lookup by Reflect, a change of the object, and a path that the sdk reaches through
// its own context.

type Fn = (...args: unknown[]) => unknown;
type Tree = { [key: string]: Tree & Fn };

function fakeApis(calls: string[]): GoogleApis {
  const method = (path: string) =>
    function (this: unknown) {
      calls.push(path);
      return Promise.resolve({ data: { path } });
    };
  const request = method('context.request');
  const gmail = {
    context: { google: { request } },
    users: {
      messages: { list: method('list'), get: method('get'), send: method('send'), modify: method('modify'), import: method('import'), insert: method('insert') },
      drafts: { create: method('drafts.create') },
      settings: { filters: { create: method('filters.create') }, forwardingAddresses: { create: method('forwarding.create') } },
      watch: method('watch'),
    },
  };
  const calendar = { events: { list: method('events.list'), quickAdd: method('events.quickAdd'), patch: method('events.patch') } };
  return { gmail, calendar } as unknown as GoogleApis;
}

describe('readOnlyApis against tricks', () => {
  it('refuses a write call made through call, apply or bind', () => {
    const calls: string[] = [];
    const apis = readOnlyApis(fakeApis(calls)) as unknown as { gmail: Tree };
    const send = apis.gmail.users!.messages!.send!;
    expect(() => send.call(undefined, {})).toThrow(ReadOnlyRefused);
    expect(() => send.apply(undefined, [{}])).toThrow(ReadOnlyRefused);
    expect(() => send.bind(undefined)({})).toThrow(ReadOnlyRefused);
    expect(calls).toEqual([]);
  });

  it('refuses a write call taken out of its object or looked up by Reflect', () => {
    const calls: string[] = [];
    const apis = readOnlyApis(fakeApis(calls)) as unknown as { gmail: Tree };
    const { modify } = apis.gmail.users!.messages!;
    expect(() => modify!({})).toThrow(ReadOnlyRefused);
    expect(() => (Reflect.get(apis.gmail.users!.messages!, 'import') as Fn)({})).toThrow(ReadOnlyRefused);
    expect(() => (apis.gmail.users!.messages!['insert'] as Fn)({})).toThrow(ReadOnlyRefused);
    expect(calls).toEqual([]);
  });

  it('refuses the calls that change settings, watch the box or reach the raw request of the sdk', () => {
    const calls: string[] = [];
    const refused: string[] = [];
    const apis = readOnlyApis(fakeApis(calls), refused) as unknown as { gmail: Tree; calendar: Tree };
    expect(() => apis.gmail.users!.settings!.filters!.create!({})).toThrow(ReadOnlyRefused);
    expect(() => apis.gmail.users!.settings!.forwardingAddresses!.create!({})).toThrow(ReadOnlyRefused);
    expect(() => apis.gmail.users!.watch!({})).toThrow(ReadOnlyRefused);
    expect(() => apis.gmail.context!.google!.request!({ method: 'POST' })).toThrow(ReadOnlyRefused);
    expect(() => apis.calendar.events!.quickAdd!({})).toThrow(ReadOnlyRefused);
    expect(() => apis.calendar.events!.patch!({})).toThrow(ReadOnlyRefused);
    expect(calls).toEqual([]);
    expect(refused).toEqual([
      'gmail.users.settings.filters.create',
      'gmail.users.settings.forwardingAddresses.create',
      'gmail.users.watch',
      'gmail.context.google.request',
      'calendar.events.quickAdd',
      'calendar.events.patch',
    ]);
  });

  it('refuses a change that would put a write call on an allowed path', () => {
    const calls: string[] = [];
    const real = fakeApis(calls);
    const apis = readOnlyApis(real) as unknown as { gmail: Tree };
    const messages = apis.gmail.users!.messages! as unknown as Record<string, unknown>;
    expect(() => {
      messages.list = (real.gmail.users.messages as unknown as Tree).send;
    }).toThrow(ReadOnlyRefused);
    expect(() => Object.defineProperty(messages, 'get', { value: () => 1 })).toThrow(ReadOnlyRefused);
    expect(() => {
      delete messages.get;
    }).toThrow(ReadOnlyRefused);
    // the real object is unchanged, so the allowed calls still read.
    void (apis.gmail.users!.messages!.list! as Fn)({});
    expect(calls).toEqual(['list']);
  });

  it('refuses the constructor of a client object, which could reach other code', () => {
    const apis = readOnlyApis(fakeApis([])) as unknown as { gmail: Tree };
    expect(() => (apis.gmail.users!.messages!.constructor as unknown as Fn)('return 1')).toThrow(ReadOnlyRefused);
  });
});
