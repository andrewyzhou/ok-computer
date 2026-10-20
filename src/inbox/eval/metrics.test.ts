import { describe, expect, it } from 'vitest';
import { failuresOf, formatReport, scrub, type EvalReport } from './metrics.js';

// a synthetic report that meets every bar.
function report(): EvalReport {
  return {
    at: '2026-10-20T14:00:00.000Z',
    commit: '0123456789abcdef0123456789abcdef01234567',
    models: { utility: ['provider/small-model'], batch: ['provider/small-model', 'provider/other-model'] },
    accounts: [
      {
        alias: 'a06',
        read: true,
        error: null,
        digest: { listed: 34, limit: 100, capped: false },
        subscriptions: { listed: 500, limit: 500, capped: true },
        newsletters: { listed: 812, limit: 2000, capped: false },
        htmlOnly: 0.4125,
      },
      {
        alias: 'school',
        read: false,
        error: 'the account needs a new sign-in',
        digest: { listed: 0, limit: 100, capped: false },
        subscriptions: { listed: 0, limit: 500, capped: false },
        newsletters: { listed: 0, limit: 2000, capped: false },
        htmlOnly: null,
      },
    ],
    digest: {
      models: true,
      messages: 34,
      person: 5,
      list: 12,
      automated: 17,
      items: 6,
      needsReply: 2,
      automatedInNeedsReply: 0,
      needsReplyFirst: true,
      automatedShown: 0,
      needsReplyRecall: 1,
      needsReplyPrecision: 0.5,
      kindAccuracy: null,
      labelled: 3,
      checked: 20,
      disagreements: 1,
      labels: true,
    },
    subscriptions: {
      models: false,
      receipts: 120,
      kinds: { charge: 40, refund: 2, order: 60, other: 18 },
      subscriptions: 4,
      amountInText: null,
      amountFound: 0.95,
      cadenceConflicts: 1,
      unknownCadence: 0,
      mixedDomains: 0,
      confidence: { low: 0, middle: 1, high: 3 },
      merchantAccuracy: null,
      amountAccuracy: null,
      cadenceAccuracy: null,
    },
    newsletters: {
      messages: 640,
      senders: 58,
      mixedDomains: 0,
      mixedNames: 2,
      methods: { one_click: 30, https: 10, mailto: 8, none: 10 },
      linkNotInHeader: 0,
      unsigned: 3,
    },
    deadlines: {
      models: true,
      mails: 34,
      mentions: 9,
      mailsWithDates: 6,
      given: 4,
      kept: 3,
      dropped: { words_not_in_mail: 1 },
      unsupported: 0,
      beforeMail: 0,
      dueAccuracy: null,
    },
    refused: ['tool inbox_draft_reply', 'tool inbox_draft_reply'],
    refusedGoogle: [],
    refusedTools: ['inbox_draft_reply', 'inbox_draft_reply'],
    failures: [],
  };
}

const without = ({ failures: _failures, ...rest }: EvalReport) => rest;

describe('failuresOf', () => {
  it('gives no failure when every bar is met', () => {
    expect(failuresOf(without(report()))).toEqual([]);
  });

  it('gives no failure for a job without metrics or a rate without a base', () => {
    const base = report();
    expect(failuresOf({ ...without(base), digest: null, subscriptions: null, newsletters: null, deadlines: null })).toEqual([]);
    expect(failuresOf(without({ ...base, subscriptions: { ...base.subscriptions!, amountInText: null } }))).toEqual([]);
  });

  const cases: Array<[string, (each: EvalReport) => EvalReport, RegExp]> = [
    ['automatedInNeedsReply', (each) => ({ ...each, digest: { ...each.digest!, automatedInNeedsReply: 2 } }), /^digest: 2 needs-reply items come from mail that no person wrote/],
    ['automatedShown', (each) => ({ ...each, digest: { ...each.digest!, automatedShown: 1 } }), /^digest: 1 automated mails/],
    ['disagreements', (each) => ({ ...each, digest: { ...each.digest!, disagreements: 3 } }), /^digest: classifyMail and the plain view disagree on 3 of 20 mails/],
    ['needsReplyFirst', (each) => ({ ...each, digest: { ...each.digest!, needsReplyFirst: false } }), /^digest: a needs-reply item comes after/],
    ['amountInText', (each) => ({ ...each, subscriptions: { ...each.subscriptions!, amountInText: 0.9 } }), /^subscriptions: 90% of the receipt amounts/],
    ['mixedDomains', (each) => ({ ...each, newsletters: { ...each.newsletters!, mixedDomains: 1 } }), /^newsletters: 1 sender groups hold more than one from domain/],
    ['linkNotInHeader', (each) => ({ ...each, newsletters: { ...each.newsletters!, linkNotInHeader: 3 } }), /^newsletters: 3 senders have a link that is not in their header/],
    ['unsupported', (each) => ({ ...each, deadlines: { ...each.deadlines!, unsupported: 1 } }), /^deadlines: 1 kept due dates are not stated/],
    ['beforeMail', (each) => ({ ...each, deadlines: { ...each.deadlines!, beforeMail: 2 } }), /^deadlines: 2 kept due dates are before the mail/],
    ['google refusals', (each) => ({ ...each, refusedGoogle: ['gmail.users.drafts.create'] }), /^google: the read-only view refused 1 calls \(gmail\.users\.drafts\.create\)/],
  ];
  it.each(cases)('gives one sentence when %s is not met', (_name, change, sentence) => {
    const failures = failuresOf(without(change(report())));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(sentence);
  });

  it('does not count the mixed names or a refused tool call as a failure', () => {
    const base = report();
    expect(failuresOf(without({ ...base, newsletters: { ...base.newsletters!, mixedNames: 9 }, refusedTools: ['inbox_create_event'] }))).toEqual([]);
  });
});

describe('formatReport', () => {
  it('prints one aligned block for each job', () => {
    const text = formatReport({ ...report(), subscriptions: null, failures: ['subscriptions: the check failed: a receipt broke it', 'school: the account could not be read'] });
    expect(text).toMatchInlineSnapshot(`
      "inbox quality check
        at            2026-10-20T14:00:00.000Z
        commit        0123456789abcdef0123456789abcdef01234567
        slot utility  provider/small-model
        slot batch    provider/small-model, provider/other-model

      accounts
        a06     digest 34 of 100, subscriptions 500 of 500 (capped), newsletters 812 of 2000, html only 41.3%
        school  digest 0 of 100, subscriptions 0 of 500, newsletters 0 of 2000, html only n/a, not read: the account needs a new sign-in

      digest
        models                    on
        messages                  34
        person                    5
        list                      12
        automated                 17
        items                     6
        needs reply               2
        automated in needs reply  0
        needs reply first         yes
        automated shown           0
        kind checked              20
        kind disagreements        1
        labelled                  3
        needs reply recall        100%
        needs reply precision     50%
        kind accuracy             n/a

      subscriptions
        failed, see the failures

      newsletters
        messages            640
        senders             58
        mixed domains       0
        mixed names         2
        one click           30
        https               10
        mailto              8
        none                10
        link not in header  0
        unsigned            3

      deadlines
        models                     on
        mails                      34
        dates in mail              9
        mails with dates           6
        given                      4
        kept                       3
        dropped words not in mail  1
        unsupported                0
        before mail                0
        due accuracy               n/a

      refused
        google  none
        tools   inbox_draft_reply x2

      failures
        subscriptions: the check failed: a receipt broke it
        school: the account could not be read"
    `);
  });

  it('says that the rates were not measured without labels', () => {
    const base = report();
    const text = formatReport({ ...base, digest: { ...base.digest!, labels: false, needsReplyRecall: null, needsReplyPrecision: null } });
    expect(text).toMatch(/needs reply recall +not measured \(no labels\)/);
    expect(text).toMatch(/kind accuracy +not measured \(no labels\)/);
  });

  it('prints the merchants only when the report holds them', () => {
    const base = report();
    expect(formatReport(base)).not.toContain('merchants');
    const named = formatReport({
      ...base,
      subscriptions: { ...base.subscriptions!, merchants: [{ account: 'a06', merchant: 'Streamly', amount: 15.49, currency: 'USD', cadence: 'monthly', confidence: 0.9 }] },
    });
    expect(named).toMatch(/ {2}merchants\n {4}a06 Streamly {2}15\.49 USD, monthly, 90%/);
  });

  it('never prints a subject, a from header, an address or a link', () => {
    const hostile = 'HOSTILE-SUBJECT-7f3a';
    const sender = 'Mallory <mallory@evil.example>';
    const base = report();
    const poisoned = {
      ...base,
      subject: hostile,
      from: sender,
      accounts: [
        { ...base.accounts[0]!, subject: hostile, from: sender },
        { ...base.accounts[1]!, error: `a request for mallory@evil.example failed at https://evil.example/x?u=mallory@evil.example` },
      ],
      digest: { ...base.digest!, subject: hostile, from: sender },
      subscriptions: { ...base.subscriptions!, subject: hostile, from: sender },
      newsletters: { ...base.newsletters!, subject: hostile, from: sender },
      deadlines: { ...base.deadlines!, subject: hostile, from: sender, dropped: { words_not_in_mail: 1 } },
      refusedGoogle: ['oneClick https://evil.example/unsub?e=mallory@evil.example'],
      failures: ['digest: the model run failed: mailto:mallory@evil.example at https://evil.example/x'],
    } as unknown as EvalReport;
    const text = formatReport(poisoned);
    expect(text).not.toContain(hostile);
    expect(text).not.toContain('Mallory');
    expect(text).not.toContain('mallory@');
    expect(text).not.toContain('evil.example');
  });
});

describe('scrub', () => {
  it('replaces links and addresses', () => {
    expect(scrub('see https://x.example/a?b=c and mailto:a@b.example or "A" <a@b.example>\n')).toBe('see <link> and <link> or "A" <<address>>');
  });
});
