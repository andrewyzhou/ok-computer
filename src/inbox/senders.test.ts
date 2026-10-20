import { describe, expect, it } from 'vitest';
import { unsubscribeTargets } from '../google/unsubscribe.js';
import { httpsLink } from './actions.js';
import { fitKey, KEY_LIMIT, phase5KeyOf, registrableDomain, senderIdentityOf, unsubscribeChoiceOf } from './senders.js';
import { corpusMessages } from './testdata/corpus.js';
import { GROUP_CASES, headersMessage, UNSUBSCRIBE_CASES } from './testdata/senders-corpus.js';

describe('registrableDomain', () => {
  it('gives the domain under the public suffix', () => {
    const table: Array<[string, string]> = [
      ['example.com', 'example.com'],
      ['mail.example.com', 'example.com'],
      ['A.B.Example.COM', 'example.com'],
      ['news.shop.co.uk', 'shop.co.uk'],
      ['shop.co.uk', 'shop.co.uk'],
      ['co.uk', 'co.uk'],
      ['cs.school.ac.uk', 'school.ac.uk'],
      ['www.charity.org.uk', 'charity.org.uk'],
      ['x.dept.gov.uk', 'dept.gov.uk'],
      ['m.store.com.au', 'store.com.au'],
      ['lists.uni.edu.au', 'uni.edu.au'],
      ['mail.shop.co.jp', 'shop.co.jp'],
      ['a.b.co.nz', 'b.co.nz'],
      ['loja.com.br', 'loja.com.br'],
      ['mail.store.co.in', 'store.co.in'],
      ['lists.school.example.edu', 'example.edu'],
      ['cs101.lists.school.example.edu', 'example.edu'],
      ['example.com.', 'example.com'],
      ['localhost', 'localhost'],
      ['LOCALHOST', 'localhost'],
      ['192.168.0.1', '192.168.0.1'],
      ['10.0.0.12', '10.0.0.12'],
      ['::1', '::1'],
      ['[2001:db8::1]', '[2001:db8::1]'],
      ['', ''],
    ];
    for (const [host, domain] of table) expect(registrableDomain(host), host).toBe(domain);
  });
});

describe('senderIdentityOf on the corpus', () => {
  const grouped = [...corpusMessages().values()].filter(({ mail }) => mail.expect.group !== undefined);

  it('gives one key to each group and different keys to different groups', () => {
    expect(grouped.length).toBeGreaterThanOrEqual(6);
    for (const a of grouped) {
      const one = senderIdentityOf(a.message);
      expect(one, a.mail.name).toBeDefined();
      for (const b of grouped) {
        if (a === b) continue;
        const two = senderIdentityOf(b.message)!;
        const same = a.mail.expect.group === b.mail.expect.group;
        expect(one!.senderKey === two.senderKey, `${a.mail.name} / ${b.mail.name}`).toBe(same);
      }
    }
  });

  it('keeps apart two customers of one list id and two organisers of one no-reply address', () => {
    const key = (id: string) => senderIdentityOf(grouped.find(({ mail }) => mail.spec.id === id)!.message)!;
    expect(key('c-news-a')).toMatchObject({ senderKey: 'a1b2c3.list-id.mailplatform.example#dailybrief.example', listId: 'a1b2c3.list-id.mailplatform.example', fromDomain: 'dailybrief.example' });
    expect(key('c-news-b')).toMatchObject({ senderKey: 'a1b2c3.list-id.mailplatform.example#example.org', fromDomain: 'example.org' });
    expect(key('c-tickets-a')).toMatchObject({ senderKey: 'noreply@tickets.example#jazz-night', listId: null, displayName: 'Jazz Night via Tickets' });
    expect(key('c-tickets-b')).toMatchObject({ senderKey: 'noreply@tickets.example#book-fair' });
  });

  it('keeps the key of phase 5 for a code host, a university list and a sender without a list id', () => {
    const of = (id: string) => senderIdentityOf(grouped.find(({ mail }) => mail.spec.id === id)!.message)!;
    expect(of('c-code')).toMatchObject({ senderKey: 'repo.org.code-host.example', fromDomain: 'code-host.example', displayName: 'Jordan' });
    expect(of('c-course-list')).toMatchObject({ senderKey: 'cs101-students.lists.school.example.edu', fromAddress: 'rivera@school.example.edu' });
    expect(of('c-forum')).toMatchObject({ senderKey: 'no-reply@forum.example.com' });
    for (const id of ['c-code', 'c-course-list', 'c-forum']) expect(phase5KeyOf(of(id))).toBe(of(id).senderKey);
  });
});

describe('senderIdentityOf on the edge cases', () => {
  for (const each of GROUP_CASES) {
    it(each.name, () => {
      const a = senderIdentityOf(headersMessage(each.a))!;
      const b = senderIdentityOf(headersMessage(each.b))!;
      expect(a.senderKey === b.senderKey).toBe(each.same);
      for (const key of [a.senderKey, b.senderKey]) {
        expect(key.length).toBeLessThanOrEqual(KEY_LIMIT);
        expect(key).toBe(key.toLowerCase());
      }
    });
  }

  it('keeps a long list id at 200 characters and gives the same key in every sweep', () => {
    const id = `${'x'.repeat(250)}.platform.example`;
    const one = senderIdentityOf(headersMessage({ From: 'a@first.example', 'List-Id': `<${id}>` }))!;
    expect(one.listId).toBe('x'.repeat(200));
    expect(one.senderKey.length).toBe(KEY_LIMIT);
    expect(senderIdentityOf(headersMessage({ From: 'a@first.example', 'List-Id': `<${id}>` }))!.senderKey).toBe(one.senderKey);
    // two keys with the same start stay apart, because the end is a hash of the whole key.
    expect(fitKey(`${'y'.repeat(300)}a`)).not.toBe(fitKey(`${'y'.repeat(300)}b`));
    expect(fitKey('short')).toBe('short');
  });

  it('gives nothing for mail that is not list mail or has no from address', () => {
    expect(senderIdentityOf(headersMessage({ From: 'friend@example.com' }))).toBeUndefined();
    expect(senderIdentityOf(headersMessage({ 'List-Id': '<a.example>' }))).toBeUndefined();
    expect(senderIdentityOf(headersMessage({ From: '"bank@x.example" <a@evil.example>, <b@evil.example>', 'List-Id': '<a.example>' }))).toBeUndefined();
  });

  it('keeps a hostile list id data and on the domain of its sender', () => {
    const hostile = senderIdentityOf(headersMessage({ From: 'Evil <x@evil.example>', 'List-Id': '<a.example OR from:bank.example>' }))!;
    expect(hostile.senderKey).toBe('a.example or from:bank.example#evil.example');
    const bank = senderIdentityOf(headersMessage({ From: 'Bank <alerts@bank.example>', 'List-Id': '<alerts.bank.example>' }))!;
    expect(bank.senderKey).toBe('alerts.bank.example');
    // a list id that names the domain of another sender does not take its key.
    const copy = senderIdentityOf(headersMessage({ From: 'Evil <x@evil.example>', 'List-Id': '<alerts.bank.example>' }))!;
    expect(copy.senderKey).not.toBe(bank.senderKey);
  });

  it('uses the plain address when the "via" name has no letters or digits', () => {
    expect(senderIdentityOf(headersMessage({ From: '"-- via Tickets" <noreply@tickets.example>', 'List-Unsubscribe': '<https://tickets.example/u>' }))!.senderKey).toBe('noreply@tickets.example');
    // a list mail keeps its list key, also with a "via" name.
    expect(senderIdentityOf(headersMessage({ From: 'Jazz via Tickets <noreply@tickets.example>', 'List-Id': '<org.tickets.example>' }))!.senderKey).toBe('org.tickets.example');
  });
});

describe('unsubscribeChoiceOf', () => {
  it('gives the method of every corpus mail', () => {
    const withMethod = [...corpusMessages().values()].filter(({ mail }) => mail.expect.unsubscribe !== undefined);
    expect(withMethod.length).toBeGreaterThanOrEqual(6);
    for (const { mail, message } of withMethod) expect(unsubscribeChoiceOf(message).method, mail.name).toBe(mail.expect.unsubscribe);
  });

  for (const each of UNSUBSCRIBE_CASES) {
    it(each.name, () => {
      expect(unsubscribeChoiceOf(headersMessage(each.headers))).toEqual({ method: each.method, url: each.url });
    });
  }

  it('always gives a url that is one of the targets of the header', () => {
    // a seeded generator, so a failure repeats.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
    const parts = [
      '<https://a.example/u/1>',
      '< https://b.example/u?x=1&amp;y=2 >',
      '<http://c.example/u>',
      '<mailto:u@d.example?subject=unsubscribe>',
      '<MAILTO:U@E.EXAMPLE>',
      '<https://f.example/u 2>',
      '<https://>',
      '<ftp://g.example/u>',
      'https://h.example/bare',
      '<>',
      '<https://i.example/\u0001>',
    ];
    const joins = [', ', ',', ',\r\n ', ' ', ',\r\n\t'];
    for (let round = 0; round < 500; round++) {
      const count = 1 + Math.floor(next() * 4);
      const value = Array.from({ length: count }, () => pick(parts)).reduce((text, part) => (text ? `${text}${pick(joins)}${part}` : part), '');
      const headers: Record<string, string> = { 'List-Unsubscribe': value };
      if (next() < 0.5) headers['List-Unsubscribe-Post'] = pick(['List-Unsubscribe=One-Click', 'list-unsubscribe=one-click', 'nothing']);
      const choice = unsubscribeChoiceOf(headersMessage(headers));
      const targets = unsubscribeTargets(value);
      if (choice.url === null) {
        expect(choice.method, value).toBe('none');
        expect(targets.some((target) => /^mailto:/i.test(target) || httpsLink(target) !== null), value).toBe(false);
        continue;
      }
      expect(targets, value).toContain(choice.url);
      expect(/^http:/i.test(choice.url), value).toBe(false);
      if (choice.method === 'mailto') expect(targets.some((target) => /^https:/i.test(target) && httpsLink(target) !== null), value).toBe(false);
      else expect(httpsLink(choice.url), value).toBe(choice.url);
    }
  });
});
