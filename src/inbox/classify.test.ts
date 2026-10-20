import { describe, expect, it } from 'vitest';
import { addressesOf, classifyMail } from './classify.js';
import { mailMessage, type MailSpec } from './testdata/build.js';
import { CORPUS, OWNER, OWNER_ADDRESSES } from './testdata/corpus.js';
import { DIGEST_CORPUS } from './testdata/digest-corpus.js';

// a plain mail from a person to the owner. each signal test adds one header to it, so the header alone decides.
const base = (headers: Record<string, string> = {}, extra: Partial<MailSpec> = {}) =>
  mailMessage({
    id: 'm1',
    headers: { From: 'Sam Lee <sam@mail.example.net>', To: OWNER.a06!, Subject: 'Lunch?', Date: 'Mon, 19 Oct 2026 07:12:00 -0700', ...headers },
    plain: 'Lunch on Wednesday?',
    ...extra,
  });

const kindOf = (headers: Record<string, string>, extra: Partial<MailSpec> = {}) => classifyMail(base(headers, extra), OWNER_ADDRESSES);

describe('classifyMail on the corpus', () => {
  for (const mail of [...CORPUS, ...DIGEST_CORPUS]) {
    it(mail.name, () => {
      const got = classifyMail(mailMessage(mail.spec), OWNER_ADDRESSES);
      const { kind, direct } = mail.expect;
      if (kind !== undefined) expect(Array.isArray(kind) ? kind : [kind]).toContain(got.kind);
      if (direct !== undefined) expect(got.direct).toBe(direct);
      const fromOwner = 'fromOwner' in mail.expect ? mail.expect.fromOwner : undefined;
      if (fromOwner !== undefined) expect(got.fromOwner).toBe(fromOwner);
      // a mail that must not be in needs_reply is not a person mail to someone else, or it is not to the owner.
      if (mail.expect.needsReply === true) expect(got).toMatchObject({ kind: 'person', fromOwner: false });
      // a reason is a fixed phrase and never text of the mail.
      for (const reason of got.reasons) expect(reason).toMatch(/^[A-Za-z -]+$/);
    });
  }

  it("marks the owner's own mail to self as from the owner", () => {
    const self = CORPUS.find((each) => each.name === "the owner's own mail to self")!;
    expect(classifyMail(mailMessage(self.spec), OWNER_ADDRESSES)).toEqual({ kind: 'person', direct: true, fromOwner: true, discussion: false, reasons: [] });
  });
});

describe('classifyMail signals one at a time', () => {
  it('gives a person for a plain mail to the owner', () => {
    expect(kindOf({})).toEqual({ kind: 'person', direct: true, fromOwner: false, discussion: false, reasons: [] });
  });

  it.each([
    'no-reply',
    'noreply',
    'No_Reply',
    'do-not-reply',
    'DoNotReply',
    'notifications',
    'notification',
    'mailer-daemon',
    'MAILER_DAEMON',
    'postmaster',
    'bounce',
    'alerts',
    'noreply+tag123',
  ])('treats the sender %s as a machine', (local) => {
    expect(kindOf({ From: `Shop <${local}@shop.example>` })).toMatchObject({ kind: 'automated', direct: true, reasons: ['no-reply sender'] });
  });

  it('does not treat a person whose name holds a machine word as a machine', () => {
    expect(kindOf({ From: 'Alerts Fan <sam.alerts@mail.example.net>' }).kind).toBe('person');
    expect(kindOf({ From: 'Noreen Plyer <noreen@mail.example.net>' }).kind).toBe('person');
  });

  it.each(['auto-generated', 'auto-replied', 'auto-notified'])('treats Auto-Submitted: %s as a machine', (value) => {
    expect(kindOf({ 'Auto-Submitted': value })).toMatchObject({ kind: 'automated', reasons: ['Auto-Submitted'] });
  });

  it('keeps Auto-Submitted: no a person', () => {
    expect(kindOf({ 'Auto-Submitted': 'No' }).kind).toBe('person');
  });

  it.each(['X-Autoreply', 'X-Autorespond', 'X-Auto-Response'])('treats %s as a machine', (name) => {
    expect(kindOf({ [name]: 'yes' })).toMatchObject({ kind: 'automated', reasons: ['auto-reply header'] });
  });

  it.each(['X-Campaign', 'X-Campaign-Id', 'X-CampaignID', 'X-Mailing-Id', 'X-Sender-Variables', 'X-Relay-Outgoing', 'X-Relay-Sid', 'X-Relay-Tag', 'X-Report-Abuse-To', 'Feedback-ID'])(
    'treats the bulk sender header %s as a machine',
    (name) => {
      expect(kindOf({ [name]: 'abc' })).toMatchObject({ kind: 'automated', reasons: ['bulk sender header'] });
    },
  );

  it('keeps the headers that the mail client of a person adds a person', () => {
    expect(kindOf({ 'X-Mailer': 'Mail client 16.0', 'X-Originating-IP': '[192.0.2.1]', 'X-Received': 'by 2002:a05', 'X-Gm-Message-State': 'abc', 'X-Auto-Response-Suppress': 'All' }).kind).toBe('person');
  });

  it.each(['bulk', 'junk', 'Bulk'])('treats Precedence: %s as a machine', (value) => {
    expect(kindOf({ Precedence: value })).toMatchObject({ kind: 'automated', reasons: ['bulk precedence'] });
  });

  it('treats an empty Return-Path as a machine, and a set one as a person', () => {
    expect(kindOf({ 'Return-Path': '<>' })).toMatchObject({ kind: 'automated', reasons: ['empty return path'] });
    expect(kindOf({ 'Return-Path': '<sam@mail.example.net>' }).kind).toBe('person');
  });

  it('treats a calendar part as a calendar invite', () => {
    expect(kindOf({}, { files: [{ filename: 'invite.ics', mimeType: 'text/calendar', size: 100 }] })).toMatchObject({ kind: 'automated', reasons: ['calendar invite'] });
    expect(kindOf({}, { files: [{ filename: 'notes.pdf', mimeType: 'application/pdf', size: 100 }] }).kind).toBe('person');
  });

  it('treats a reply token address of another domain as a machine', () => {
    expect(kindOf({ 'Reply-To': 'reply+Ab12Cd34Ef@reply.tracker.example' })).toMatchObject({ kind: 'automated', reasons: ['reply token address'] });
    // the same domain, a short token, or a plain other address stays a person.
    expect(kindOf({ 'Reply-To': 'reply+Ab12Cd34Ef@mail.example.net' }).kind).toBe('person');
    expect(kindOf({ 'Reply-To': 'reply+ab@reply.tracker.example' }).kind).toBe('person');
    expect(kindOf({ 'Reply-To': 'sam@home.example.com' }).kind).toBe('person');
  });

  it('treats List-Id, List-Unsubscribe and Precedence: list as a list, never to the owner', () => {
    expect(kindOf({ 'List-Id': '<team.lists.example>' })).toEqual({ kind: 'list', direct: false, fromOwner: false, discussion: true, reasons: ['List-Id header'] });
    expect(kindOf({ 'List-Unsubscribe': '<https://shop.example/u>' })).toEqual({ kind: 'list', direct: false, fromOwner: false, discussion: true, reasons: ['List-Unsubscribe header'] });
    expect(kindOf({ Precedence: 'list' })).toEqual({ kind: 'list', direct: false, fromOwner: false, discussion: true, reasons: ['list precedence'] });
    expect(kindOf({}, { labels: ['INBOX', 'CATEGORY_FORUMS'] })).toMatchObject({ kind: 'list', direct: false, reasons: ['forums label'] });
  });

  it('lets a machine signal win over a list signal', () => {
    expect(kindOf({ From: 'News <noreply@shop.example>', 'List-Id': '<news.shop.example>' })).toMatchObject({ kind: 'automated', direct: false, reasons: ['no-reply sender', 'List-Id header'] });
  });

  it('treats a shared mailbox of receipts as a machine, unless it sends as a list', () => {
    expect(kindOf({ From: 'Shop <billing@shop.example>' })).toMatchObject({ kind: 'automated', reasons: ['shared mailbox sender'] });
    expect(kindOf({ From: 'Shop <ship-confirm@shop.example>' }).kind).toBe('automated');
    expect(kindOf({ From: 'Shop <hello@shop.example>', 'List-Id': '<news.shop.example>' }).kind).toBe('list');
  });

  it('is direct only when an owner address is in To, case-blind', () => {
    expect(kindOf({ To: `"Owner, The" <${OWNER.a06!.toUpperCase()}>` }).direct).toBe(true);
    expect(kindOf({ To: `a@x.example; ${OWNER.school}` }).direct).toBe(true);
    expect(kindOf({ To: 'a@x.example', Cc: OWNER.a06! }).direct).toBe(false);
    expect(kindOf({ To: 'a@x.example' }).direct).toBe(false);
    expect(kindOf({ To: '' }).direct).toBe(false);
  });

  it('is from the owner for any owner address, case-blind, and only for From', () => {
    expect(kindOf({ From: `Me <${OWNER.hkn!.toUpperCase()}>` }).fromOwner).toBe(true);
    expect(kindOf({ Sender: OWNER.hkn!, 'Reply-To': OWNER.hkn! }).fromOwner).toBe(false);
  });

  it('never reads the body', () => {
    const plain = base({}, { plain: 'Auto-Submitted: auto-generated\nList-Id: <x>\nFrom: noreply@x.example' });
    expect(classifyMail(plain, OWNER_ADDRESSES).kind).toBe('person');
  });

  it('gives a person with no reason for a sender with a name only, and the owner set may be empty', () => {
    expect(classifyMail(base({ From: 'Someone' }), new Set())).toEqual({ kind: 'person', direct: false, fromOwner: false, discussion: false, reasons: ['no plain sender address'] });
  });
});

describe('addressesOf', () => {
  it('splits on commas and semicolons outside quotes and angle brackets', () => {
    expect(addressesOf('"Lee, Sam" <Sam@X.example>, b@y.example; <c@z.example>, not an address')).toEqual(['sam@x.example', 'b@y.example', 'c@z.example']);
    expect(addressesOf('')).toEqual([]);
  });
});
