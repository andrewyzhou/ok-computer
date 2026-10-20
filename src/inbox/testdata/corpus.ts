import type { gmail_v1 } from '@googleapis/gmail';
import type { DigestSection, UnsubscribeMethod } from '../../dashboard/types.js';
import type { MailKind } from '../../dashboard/inbox-types.js';
import type { ReceiptKind, StatedCadence } from '../receipts.js';
import { mailMessage, type MailSpec } from './build.js';

// the shared corpus of the inbox tests: made-up mail in the shapes that the owner's real mail has (html-only senders,
// receipts of several merchants, course mail, code host notifications, security alerts, newsletters of a mail
// platform), each with what the jobs should make of it. the work packages test their functions against it. this file
// stays as the scaffold wrote it, so the packages agree on it; a package adds the mail of its own cases in a corpus
// file of its own next to this one.
//
// the owner has five accounts, as in the real setup. each mail names the account that received it. the mails of the
// digest are from 2026-10-19 (a monday) in America/Los_Angeles, so a weekday such as "friday" is 2026-10-24.

export const OWNER: Record<string, string> = {
  a06: 'owner.a06@example.com',
  yurun: 'owner.yurun@example.com',
  a581: 'owner.a581@example.com',
  school: 'owner@school.example.edu',
  hkn: 'owner@club.school.example.edu',
};
export const OWNER_ADDRESSES: ReadonlySet<string> = new Set(Object.values(OWNER));
export const TIME_ZONE = 'America/Los_Angeles';

// what a job should give for one mail. a field that is left out has no expectation.
export interface Expect {
  // the kind from classifyMail. a list means that any of them is right.
  kind?: MailKind | MailKind[];
  direct?: boolean;
  // true when the digest must put the mail in needs_reply, false when it must not.
  needsReply?: boolean;
  // the other section that the digest should give, or null when it should give none.
  section?: Exclude<DigestSection, 'needs_reply'> | null;
  // the local due day (yyyy-mm-dd) that the digest keeps, or null when it must keep no due date.
  due?: string | null;
  // the receipt facts that the subscription finder should find.
  receipt?: { kind: ReceiptKind; merchant?: string; amount?: number; currency?: string; cadence?: StatedCadence | null };
  // a name of the newsletter group. two mails with the same group must share a sender key, and two with different
  // groups must not.
  group?: string;
  unsubscribe?: UnsubscribeMethod;
}

export interface CorpusMail {
  name: string;
  account: keyof typeof OWNER;
  spec: MailSpec;
  expect: Expect;
}

// the headers of a list mail that gmail checked: a passing dkim result of mx.google.com and a signature that covers
// the unsubscribe headers.
function signed(domain: string, extra: string[] = []): Record<string, string> {
  return {
    'Authentication-Results': `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=AbCdEf12; spf=pass smtp.mailfrom=${domain}`,
    'DKIM-Signature': `v=1; a=rsa-sha256; d=${domain}; s=s1; h=from:to:subject:date:list-unsubscribe:list-unsubscribe-post${extra.length ? `:${extra.join(':')}` : ''}; b=AbCdEf12xyz`,
  };
}

const MON = 'Mon, 19 Oct 2026 07:12:00 -0700';

export const CORPUS: CorpusMail[] = [
  {
    name: 'professor asks a question',
    account: 'school',
    spec: {
      id: 'c-prof',
      headers: { From: 'Dana Rivera <rivera@school.example.edu>', To: OWNER.school!, Subject: 'Project check-in', Date: MON },
      plain: 'Hi,\n\nCould you tell me by Wednesday whether Thursday at 3 pm works for the project check-in?\n\nDana',
    },
    expect: { kind: 'person', direct: true, needsReply: true },
  },
  {
    name: 'friend asks to rsvp by a date',
    account: 'a06',
    spec: {
      id: 'c-rsvp',
      headers: { From: '"Sam Lee" <sam.lee@mail.example.net>', To: OWNER.a06!, Subject: 'Dinner on the 30th?', Date: MON },
      html: '<div dir="ltr">Hey!<div><br></div><div>We are doing dinner on Friday, October 30. Can you let me know by Oct 27 if you can make it?</div><div><br></div><div>Sam</div></div>',
    },
    expect: { kind: 'person', direct: true, needsReply: true, due: '2026-10-27' },
  },
  {
    name: 'person mail where the owner is only in cc',
    account: 'yurun',
    spec: {
      id: 'c-cc',
      headers: { From: 'Alex Kim <alex@work.example.org>', To: 'team@work.example.org', Cc: OWNER.yurun!, Subject: 'Notes from today', Date: MON },
      plain: 'Team, the notes from today are below. Nothing is needed from anyone yet.\n\n1. The launch moves a week.\n2. The review is next month.',
    },
    expect: { kind: 'person', direct: false, needsReply: false },
  },
  {
    name: "the owner's own mail to self",
    account: 'a581',
    spec: {
      id: 'c-self',
      headers: { From: OWNER.a581!, To: OWNER.a581!, Subject: 'note to self', Date: MON },
      plain: 'Buy a new charger and call the bank about the card.',
    },
    expect: { needsReply: false },
  },
  {
    name: 'code host notification of a comment',
    account: 'a06',
    spec: {
      id: 'c-code',
      headers: {
        From: 'Jordan <notifications@code-host.example>',
        To: 'org/repo <repo@noreply.code-host.example>',
        Cc: `Mention <mention@noreply.code-host.example>, ${OWNER.a06}`,
        'Reply-To': 'org/repo <reply+ABC123@reply.code-host.example>',
        Subject: 'Re: [org/repo] Fix the parser (PR #42)',
        Date: MON,
        'List-Id': 'org/repo <repo.org.code-host.example>',
        'List-Unsubscribe': '<mailto:unsub+ABC@reply.code-host.example>, <https://code-host.example/notifications/unsubscribe/ABC>',
        Precedence: 'list',
        'X-Auto-Response-Suppress': 'All',
        ...signed('code-host.example'),
      },
      plain: '@owner can you take a look at this before Friday?\n\n--\nReply to this email directly or view it on the site.',
      html: '<p>@owner can you take a look at this before Friday?</p><p>Reply to this email directly or <a href="https://code-host.example/org/repo/pull/42">view it on the site</a>.</p>',
    },
    expect: { kind: ['list', 'automated'], needsReply: false, group: 'code-host org/repo', unsubscribe: 'https' },
  },
  {
    name: 'security alert of the mail provider',
    account: 'yurun',
    spec: {
      id: 'c-security',
      headers: { From: 'Accounts <no-reply@accounts.provider.example>', To: OWNER.yurun!, Subject: 'Security alert', Date: MON },
      html: '<html><head><style>.x{color:red}</style></head><body><table><tr><td><span style="display:none">A new sign-in&zwnj;&nbsp;&zwnj;&nbsp;</span>A new sign-in on a Mac</td></tr><tr><td>If this was you, you don&#39;t need to do anything.</td></tr><tr><td><a href="https://myaccount.provider.example/alert">Check activity</a></td></tr></table></body></html>',
    },
    expect: { kind: 'automated', direct: true, needsReply: false, section: null, due: null },
  },
  {
    name: 'course site announcement with a due date',
    account: 'school',
    spec: {
      id: 'c-course-due',
      headers: { From: 'CS 101 <notifications@lms.school.example.edu>', To: OWNER.school!, Subject: 'Homework 6 released', Date: MON, 'Auto-Submitted': 'auto-generated' },
      html: '<div><h2>Homework 6 released</h2><p>Homework 6 is out. It is due <b>Friday, October 24 at 11:59 PM PT</b> on the course site.</p><p><a href="https://lms.school.example.edu/courses/1/assignments/6">Open the assignment</a></p></div>',
    },
    expect: { kind: 'automated', needsReply: false, section: 'deadlines', due: '2026-10-24' },
  },
  {
    name: 'course mail with no date',
    account: 'school',
    spec: {
      id: 'c-course-nodate',
      headers: { From: 'CS 101 <notifications@lms.school.example.edu>', To: OWNER.school!, Subject: 'Midterm logistics', Date: MON, 'Auto-Submitted': 'auto-generated' },
      html: '<p>The midterm is coming up soon. We will post the room and the time later.</p>',
    },
    expect: { kind: 'automated', needsReply: false, due: null },
  },
  {
    name: 'course forum digest',
    account: 'school',
    spec: {
      id: 'c-forum',
      headers: {
        From: 'Course Forum <no-reply@forum.example.com>',
        To: OWNER.school!,
        Subject: 'CS 101: 12 new posts',
        Date: MON,
        'List-Unsubscribe': '<https://forum.example.com/unsubscribe?u=1&t=abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        ...signed('forum.example.com'),
      },
      html: '<p>12 new posts in CS 101.</p><ul><li>Question about homework 6</li><li>Office hours this week</li></ul>',
    },
    expect: { kind: ['list', 'automated'], needsReply: false, group: 'forum', unsubscribe: 'one_click' },
  },
  {
    name: 'monthly plan receipt, html only',
    account: 'a06',
    spec: {
      id: 'c-streamly-1',
      headers: { From: 'Streamly <billing@streamly.example>', To: OWNER.a06!, Subject: 'Your Streamly receipt', Date: 'Sat, 3 Oct 2026 10:00:00 +0000' },
      html: '<table><tr><td>Premium plan</td><td>$15.49/month</td></tr><tr><td><b>Total charged</b></td><td><b>$15.49</b></td></tr></table><p>Your plan renews on November 3, 2026. <a href="https://streamly.example/account/cancel">Manage or cancel</a></p>',
    },
    expect: { kind: 'automated', needsReply: false, receipt: { kind: 'charge', merchant: 'Streamly', amount: 15.49, currency: 'USD', cadence: 'monthly' } },
  },
  {
    name: 'monthly plan receipt of the month before',
    account: 'a06',
    spec: {
      id: 'c-streamly-0',
      headers: { From: 'Streamly <billing@streamly.example>', To: OWNER.a06!, Subject: 'Your Streamly receipt', Date: 'Thu, 3 Sep 2026 10:00:00 +0000' },
      html: '<table><tr><td>Premium plan</td><td>$15.49/month</td></tr><tr><td><b>Total charged</b></td><td><b>$15.49</b></td></tr></table>',
    },
    expect: { receipt: { kind: 'charge', merchant: 'Streamly', amount: 15.49, currency: 'USD', cadence: 'monthly' } },
  },
  {
    name: 'yearly plan receipt in euro',
    account: 'yurun',
    spec: {
      id: 'c-notes-year',
      headers: { From: 'Cloud Notes <hello@cloudnotes.example.eu>', To: OWNER.yurun!, Subject: 'Thanks for renewing', Date: 'Sun, 1 Mar 2026 09:00:00 +0100' },
      plain: 'Thanks for renewing Cloud Notes Pro.\n\nAmount: 96,00 €\nBilled annually. Your next renewal is on 1 March 2027.\n',
    },
    // a mail from hello@ with no other mark of a machine reads as a person, because a person of a small shop or a club
    // answers from such a box. the digest still shows it only when the model finds a section for it.
    expect: { kind: 'person', receipt: { kind: 'charge', merchant: 'Cloud Notes', amount: 96, currency: 'EUR', cadence: 'yearly' } },
  },
  {
    name: 'payment platform receipt for another merchant',
    account: 'a581',
    spec: {
      id: 'c-payflow',
      headers: { From: 'PayFlow <service@payflow.example>', To: OWNER.a581!, Subject: 'Receipt for your payment to Gym Plus', Date: 'Mon, 5 Oct 2026 08:00:00 -0700' },
      html: '<p>You sent an automatic payment of <b>$42.00 USD</b> to Gym Plus.</p><p>This is a monthly automatic payment. You can stop it in your settings.</p>',
    },
    expect: { kind: 'automated', receipt: { kind: 'charge', merchant: 'Gym Plus', amount: 42, currency: 'USD', cadence: 'monthly' } },
  },
  {
    name: 'order that shipped',
    account: 'a06',
    spec: {
      id: 'c-shipped',
      headers: { From: 'Shop <ship-confirm@shop.example>', To: OWNER.a06!, Subject: 'Your order has shipped', Date: MON },
      html: '<p>Your order #113-55 has shipped.</p><p>Order total: $23.80</p><p>Arriving Wednesday, October 21. <a href="https://shop.example/track/113-55">Track package</a></p>',
    },
    expect: { kind: 'automated', needsReply: false, section: 'packages', receipt: { kind: 'order' } },
  },
  {
    name: 'refund',
    account: 'a06',
    spec: {
      id: 'c-refund',
      headers: { From: 'Shop <returns@shop.example>', To: OWNER.a06!, Subject: 'Your refund was issued', Date: MON },
      plain: "We've issued a refund of $12.00 to your card ending in 1234. It can take 5 to 10 days to show.",
    },
    expect: { kind: 'automated', needsReply: false, receipt: { kind: 'refund', amount: 12, currency: 'USD' } },
  },
  {
    name: 'utility bill that is due',
    account: 'a581',
    spec: {
      id: 'c-bill',
      headers: { From: 'City Power <ebill@citypower.example>', To: OWNER.a581!, Subject: 'Your October statement is ready', Date: MON },
      html: '<p>Your statement is ready.</p><table><tr><td>Amount due</td><td>$84.20</td></tr><tr><td>Due date</td><td>October 28, 2026</td></tr></table>',
    },
    expect: { kind: 'automated', needsReply: false, section: 'bills', due: '2026-10-28', receipt: { kind: 'order' } },
  },
  {
    name: 'newsletter of a mail platform',
    account: 'hkn',
    spec: {
      id: 'c-news-a',
      headers: {
        From: 'Daily Brief <news@dailybrief.example>',
        To: OWNER.hkn!,
        Subject: 'Today: the five things to know',
        Date: MON,
        'List-Id': '<a1b2c3.list-id.mailplatform.example>',
        'List-Unsubscribe': '<https://dailybrief.example/u?id=1>, <mailto:unsub@dailybrief.example?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        ...signed('dailybrief.example'),
      },
      html: '<p>Good morning. Here are the five things to know today.</p>',
    },
    expect: { kind: 'list', needsReply: false, group: 'daily brief', unsubscribe: 'one_click' },
  },
  {
    name: 'another sender with the same list id on another domain',
    account: 'hkn',
    spec: {
      id: 'c-news-b',
      headers: {
        From: 'Garden Club <hello@gardenclub.example.org>',
        To: OWNER.hkn!,
        Subject: 'October meeting',
        Date: MON,
        'List-Id': '<a1b2c3.list-id.mailplatform.example>',
        'List-Unsubscribe': '<https://gardenclub.example.org/unsubscribe/9>',
        ...signed('gardenclub.example.org'),
      },
      html: '<p>The October meeting is on the 28th.</p>',
    },
    expect: { kind: 'list', needsReply: false, group: 'garden club', unsubscribe: 'https' },
  },
  {
    name: 'ticket platform for one organiser',
    account: 'a06',
    spec: {
      id: 'c-tickets-a',
      headers: {
        From: 'Jazz Night via Tickets <noreply@tickets.example>',
        To: OWNER.a06!,
        Subject: 'Jazz Night: new dates',
        Date: MON,
        'List-Unsubscribe': '<https://tickets.example/unsubscribe/org/111>',
        ...signed('tickets.example'),
      },
      html: '<p>New dates for Jazz Night are out.</p>',
    },
    expect: { kind: ['list', 'automated'], needsReply: false, group: 'tickets jazz night', unsubscribe: 'https' },
  },
  {
    name: 'ticket platform for another organiser',
    account: 'a06',
    spec: {
      id: 'c-tickets-b',
      headers: {
        From: 'Book Fair via Tickets <noreply@tickets.example>',
        To: OWNER.a06!,
        Subject: 'Book Fair is next week',
        Date: MON,
        'List-Unsubscribe': '<https://tickets.example/unsubscribe/org/222>',
        ...signed('tickets.example'),
      },
      html: '<p>The Book Fair is next week.</p>',
    },
    expect: { kind: ['list', 'automated'], needsReply: false, group: 'tickets book fair', unsubscribe: 'https' },
  },
  {
    name: 'a professor mails the course list',
    account: 'school',
    spec: {
      id: 'c-course-list',
      headers: {
        From: 'Dana Rivera <rivera@school.example.edu>',
        To: 'cs101-students@lists.school.example.edu',
        Subject: '[cs101] No lecture on Thursday',
        Date: MON,
        'List-Id': 'CS 101 students <cs101-students.lists.school.example.edu>',
        'List-Unsubscribe': '<mailto:cs101-students+unsubscribe@lists.school.example.edu>',
        Precedence: 'list',
      },
      plain: 'Hi all, there is no lecture on Thursday. Office hours are as usual.',
    },
    expect: { kind: 'list', direct: false, needsReply: false, group: 'cs101 list', unsubscribe: 'mailto' },
  },
];

// the corpus as gmail messages, by name.
export const corpusMessages = (): Map<string, { mail: CorpusMail; message: gmail_v1.Schema$Message }> =>
  new Map(CORPUS.map((mail) => [mail.name, { mail, message: mailMessage(mail.spec) }]));
