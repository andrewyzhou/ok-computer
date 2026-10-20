import type { gmail_v1 } from '@googleapis/gmail';
import { mailMessage } from './build.js';
import { OWNER, type CorpusMail } from './corpus.js';

// the receipts of the subscription finder that the shared corpus does not hold: notices that move no money, an app
// store receipt with several items, and receipts in more formats of amounts. all names and domains are made up.

export const RECEIPTS_CORPUS: CorpusMail[] = [
  {
    name: 'price change notice',
    account: 'personal',
    spec: {
      id: 'r-price',
      headers: { From: 'Streamly <billing@streamly.example>', To: OWNER.personal!, Subject: 'An update to your Streamly price', Date: 'Mon, 12 Oct 2026 10:00:00 +0000' },
      html: '<p>Your price is changing.</p><p>From November 3, 2026 your Premium plan will be <b>$17.99/month</b>. You will be charged the new price on your next billing date.</p><p><a href="https://streamly.example/account">Manage your plan</a></p>',
    },
    expect: { receipt: { kind: 'other', cadence: 'monthly' } },
  },
  {
    name: 'trial ending notice',
    account: 'work',
    spec: {
      id: 'r-trial',
      headers: { From: 'Photo Box <hello@photobox.example>', To: OWNER.work!, Subject: 'Your trial ends in 3 days', Date: 'Wed, 14 Oct 2026 09:00:00 +0000' },
      html: '<p>Your free trial ends on October 17.</p><p>After that, your plan renews at US$4.99 per month unless you cancel.</p>',
    },
    expect: { receipt: { kind: 'other', cadence: 'monthly' } },
  },
  {
    name: 'free plan receipt of zero',
    account: 'side',
    spec: {
      id: 'r-zero',
      headers: { From: 'Notes Pad <billing@notespad.example>', To: OWNER.side!, Subject: 'Your Notes Pad receipt', Date: 'Thu, 1 Oct 2026 12:00:00 +0000' },
      html: '<table><tr><td>Starter plan</td><td>$0.00</td></tr><tr><td>Total</td><td>$0.00</td></tr></table>',
    },
    expect: { receipt: { kind: 'other', amount: 0, currency: 'USD' } },
  },
  {
    name: 'app store receipt with several items',
    account: 'personal',
    spec: {
      id: 'r-appstore',
      headers: { From: 'App Market <no_reply@email.appmarket.example>', To: OWNER.personal!, Subject: 'Your receipt from App Market', Date: 'Fri, 9 Oct 2026 18:00:00 +0000' },
      html: '<h2>Receipt</h2><table><tr><td>Sky Maps Pro (Monthly)</td><td>Renews November 9, 2026</td><td>$2.99</td></tr><tr><td>Puzzle Pack</td><td>$0.99</td></tr><tr><td>Subtotal</td><td>$3.98</td></tr><tr><td>Tax</td><td>$0.35</td></tr><tr><td><b>TOTAL</b></td><td><b>$4.33</b></td></tr></table><p><a href="https://apps.appmarket.example/subscriptions">Manage subscriptions</a></p>',
    },
    expect: { receipt: { kind: 'charge', merchant: 'Sky Maps Pro', amount: 2.99, currency: 'USD', cadence: 'monthly' } },
  },
  {
    name: 'receipt in pounds',
    account: 'club',
    spec: {
      id: 'r-pounds',
      headers: { From: 'Gym Club <accounts@gymclub.co.uk>', To: OWNER.club!, Subject: 'Payment received', Date: 'Thu, 1 Oct 2026 07:00:00 +0100' },
      plain: 'Thanks, we have received your membership payment.\n\nAmount paid\n£4.50\n\nYour membership renews every month.',
    },
    expect: { receipt: { kind: 'charge', merchant: 'Gym Club', amount: 4.5, currency: 'GBP', cadence: 'monthly' } },
  },
  {
    name: 'receipt in yen',
    account: 'personal',
    spec: {
      id: 'r-yen',
      headers: { From: 'Manga Cloud <billing@mangacloud.co.jp>', To: OWNER.personal!, Subject: 'Your Manga Cloud receipt', Date: 'Mon, 5 Oct 2026 01:00:00 +0900' },
      html: '<p>Thank you for your payment.</p><p>Amount charged: ¥1,200</p><p>Billed annually.</p>',
    },
    expect: { receipt: { kind: 'charge', merchant: 'Manga Cloud', amount: 1200, currency: 'JPY', cadence: 'yearly' } },
  },
  {
    name: 'offer to upgrade',
    account: 'work',
    spec: {
      id: 'r-offer',
      headers: { From: 'Cloud Notes <hello@cloudnotes.example.eu>', To: OWNER.work!, Subject: 'Your subscription: 40% off Pro for a limited time', Date: 'Tue, 6 Oct 2026 09:00:00 +0100' },
      html: '<p>Upgrade now and get 40% off Pro: only 57,60 € per year.</p>',
    },
    expect: { receipt: { kind: 'other', cadence: 'yearly' } },
  },
];

// the receipts as gmail messages, by name.
export const receiptMessages = (): Map<string, { mail: CorpusMail; message: gmail_v1.Schema$Message }> =>
  new Map(RECEIPTS_CORPUS.map((mail) => [mail.name, { mail, message: mailMessage(mail.spec) }]));
