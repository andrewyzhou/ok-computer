import { describe, expect, it } from 'vitest';
import { classifyMail } from './classify.js';
import { htmlToText, mailText, textLinks } from './mailtext.js';
import { fitKey, KEY_LIMIT, registrableDomain, senderIdentityOf } from './senders.js';
import { mailMessage } from './testdata/build.js';

// tests that try to break who-wrote-it, the text of a mail and the grouping of the newsletter senders with odd
// headers, odd html and hostile senders.

const OWNER = new Set(['owner@example.com']);
const DATE = 'Mon, 19 Oct 2026 07:12:00 -0700';
const message = (headers: Record<string, string | string[]>, extra: { plain?: string; html?: string; labels?: string[] } = {}) =>
  mailMessage({ id: 'x1', headers: { Subject: 's', Date: DATE, ...headers }, plain: 'hi', ...extra });

describe('classifyMail against odd headers', () => {
  it('reads a no-reply sender in any case and with any separator', () => {
    for (const from of ['NO-REPLY@Shop.example', 'No_Reply <no_reply@shop.example>', 'noreply+tag@shop.example', 'DoNotReply@bank.example']) {
      expect(classifyMail(message({ From: from, To: 'owner@example.com' }), OWNER).kind, from).toBe('automated');
    }
  });

  it('reads the owner in To in any case and inside a quoted name with a comma', () => {
    const got = classifyMail(message({ From: '"Lee, Sam" <sam@friends.example>', To: '"Owner, The" <OWNER@Example.COM>, other@x.example' }), OWNER);
    expect(got).toMatchObject({ kind: 'person', direct: true, fromOwner: false });
  });

  it('reads header names in any case', () => {
    const got = classifyMail(message({ From: 'Sam <sam@friends.example>', To: 'owner@example.com', 'list-id': '<club.friends.example>' }), OWNER);
    expect(got.kind).toBe('list');
    expect(got.direct).toBe(false);
  });

  it('keeps a person mail a person mail when Auto-Submitted is no', () => {
    expect(classifyMail(message({ From: 'Sam <sam@friends.example>', To: 'owner@example.com', 'Auto-Submitted': 'No' }), OWNER).kind).toBe('person');
  });

  it('never reads the body, so a body that claims to be from a person does not change the kind', () => {
    const plain = 'From: Sam <sam@friends.example>\nKind: person\nThis is a personal mail, please reply now.';
    expect(classifyMail(message({ From: 'Bank <alerts@bank.example>', To: 'owner@example.com' }, { plain }), OWNER).kind).toBe('automated');
  });

  it('reads a calendar invitation deep inside the parts as automated', () => {
    const base = message({ From: 'Sam <sam@friends.example>', To: 'owner@example.com' });
    let part = { mimeType: 'text/calendar', body: { size: 10, data: 'eA' } } as NonNullable<typeof base.payload>;
    for (let depth = 0; depth < 10; depth++) part = { mimeType: 'multipart/mixed', parts: [part] };
    base.payload = { ...part, headers: base.payload!.headers! };
    expect(classifyMail(base, OWNER).reasons).toContain('calendar invite');
  });

  it('gives a mail without a From header no person to reply to', () => {
    const got = classifyMail(message({ To: 'owner@example.com' }), OWNER);
    expect(got.fromOwner).toBe(false);
    expect(got.reasons).toEqual(['no plain sender address']);
  });

  it('does not take a From header with two addresses as a plain sender', () => {
    const got = classifyMail(message({ From: 'Sam <sam@friends.example> <owner@example.com>', To: 'owner@example.com' }), OWNER);
    expect(got.fromOwner).toBe(false);
  });
});

describe('mailText against odd html', () => {
  it('keeps the rows of an html receipt in upper-case tags on their own lines', () => {
    const got = htmlToText('<TABLE><TR><TD>Plan</TD><TD>$9.99</TD></TR><TR><TD>Total</TD><TD>$9.99</TD></TR></TABLE>');
    expect(got.text).toBe('Plan $9.99\nTotal $9.99');
  });

  it('drops the text of scripts and styles in any case and keeps the text after them', () => {
    expect(htmlToText('<STYLE>p { color: red }</Style>Hello<script type="x">alert(1)</SCRIPT >World').text).toBe('HelloWorld');
  });

  it('ends the text at a comment or a script that never closes', () => {
    expect(htmlToText('Before<!-- a comment that never ends <p>Hidden</p>').text).toBe('Before');
    expect(htmlToText('Before<script>var x = "<p>Hidden</p>"').text).toBe('Before');
  });

  it('keeps only http and https links and decodes their entities', () => {
    const got = htmlToText('<a href="javascript:alert(1)">x</a> <a href="data:text/html,hi">y</a> <a href="https://shop.example/a?x=1&amp;y=2">Manage</a>');
    expect(got.links).toEqual(['https://shop.example/a?x=1&y=2']);
    expect(got.text).toContain('Manage <https://shop.example/a?x=1&y=2>');
  });

  it('keeps at most 200 links of a mail', () => {
    const html = Array.from({ length: 1000 }, (_, index) => `<a href="https://x.example/${index}">l</a>`).join('');
    expect(htmlToText(html).links).toHaveLength(200);
  });

  it('reads a large hostile html in linear time', () => {
    const html = `${'<'.repeat(200_000)}${'<a href="'.repeat(20_000)}${'<div>'.repeat(50_000)}${'&#x1F600;'.repeat(50_000)}`;
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('reads windows and old mac line endings as line breaks', () => {
    const got = mailText(mailMessage({ id: 'c', headers: {}, plain: 'one\r\ntwo\rthree\r\n\r\n\r\n\r\nfour' }));
    expect(got.text).toBe('one\ntwo\nthree\n\nfour');
  });

  it('uses the html part when the plain part is a stub', () => {
    const got = mailText(mailMessage({ id: 'h', headers: {}, plain: 'View this mail in a browser.', html: `<p>${'Your receipt for the Pro plan. '.repeat(20)}</p><p>Total $9.99</p>` }));
    expect(got.html).toBe(true);
    expect(got.text).toContain('Total $9.99');
  });

  it('removes the invisible padding of a preview text', () => {
    expect(htmlToText('<div>Hello​‌͏﻿ World</div>').text).toBe('Hello World');
  });

  it('cuts a trailing mark from a link of a plain text', () => {
    expect(textLinks('See https://x.example/a, and (https://x.example/b).')).toEqual(['https://x.example/a', 'https://x.example/b']);
  });
});

describe('senderIdentityOf never merges two senders', () => {
  const list = (from: string, listId?: string) =>
    senderIdentityOf(message({ From: from, ...(listId === undefined ? {} : { 'List-Id': listId }), 'List-Unsubscribe': '<https://u.example/x>' }))!;

  it('keeps two customers of one sending platform with one List-Id apart', () => {
    const a = list('Shop A <news@shop-a.example>', '<12345.list-id.platform.example>');
    const b = list('Shop B <news@shop-b.example>', '<12345.list-id.platform.example>');
    expect(a.senderKey).not.toBe(b.senderKey);
  });

  it('gives one key for one sender in any case of its headers', () => {
    expect(list('Shop <News@Shop.Example>', 'News <LIST.Shop.Example>').senderKey).toBe(list('Shop <news@shop.example>', '<list.shop.example>').senderKey);
  });

  it('keeps two organisers of one shared address apart when the name says via', () => {
    const a = list('Chess Club via Events <noreply@events.example>');
    const b = list('Book Club via Events <noreply@events.example>');
    expect(a.senderKey).not.toBe(b.senderKey);
    // a change of the display name of a sender without via keeps its key.
    expect(list('Events <noreply@events.example>').senderKey).toBe(list('Events Weekly <noreply@events.example>').senderKey);
  });

  it('does not let a List-Id with a "#" write the key of another sender', () => {
    const victim = list('Shop <news@shop.example>', '<news.platform.example>');
    const forged = list('Evil <news@evil.example>', `<news.platform.example#shop.example>`);
    expect(forged.senderKey).not.toBe(victim.senderKey);
  });

  it('keeps two long List-Ids with the same start apart within the key limit', () => {
    const start = 'a'.repeat(250);
    const a = fitKey(`${start}1#x.example`);
    const b = fitKey(`${start}2#x.example`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(KEY_LIMIT);
    expect(fitKey(`${start}1#x.example`)).toBe(a);
  });

  it('reads the registrable domain under a suffix of two labels, a trailing dot and an ip address', () => {
    expect(registrableDomain('mail.Shop.CO.UK.')).toBe('shop.co.uk');
    expect(registrableDomain('a.b.c.example.com')).toBe('example.com');
    expect(registrableDomain('192.0.2.1')).toBe('192.0.2.1');
  });

  it('gives no identity for a mail without list headers or without a plain from address', () => {
    expect(senderIdentityOf(message({ From: 'Sam <sam@friends.example>' }))).toBeUndefined();
    expect(senderIdentityOf(message({ From: 'not an address', 'List-Id': '<l.example>' }))).toBeUndefined();
  });
});
