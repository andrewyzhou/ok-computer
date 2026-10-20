import type { gmail_v1 } from '@googleapis/gmail';
import type { MailKind } from '../../dashboard/inbox-types.js';
import { fromAddress, header } from '../../google/mime.js';
import { addDays, localDay } from '../../time.js';
import { addressesOf, mailboxOf } from '../classify.js';
import { registrableDomain } from '../domains.js';

// a second, plain view of each mail and each due date for the quality check, built without classifyMail, findDates
// and checkDue. the bars of the check compare the jobs with this view, so a change that breaks those functions shows
// in the bars even without a labels file. the view is rough on purpose and often has no opinion: then it gives null
// and the mail counts for no bar.

// the senders whose mail is a notification: the registrable domains of services that send only machine mail to the
// owner, and the hosts of a larger domain whose mail is machine mail.
const NOTIFIER_DOMAINS = new Set([
  'github.com',
  'gitlab.com',
  'instructure.com',
  'gradescope.com',
  'piazza.com',
  'edstem.org',
  'linkedin.com',
  'slack.com',
  'zoom.us',
  'calendly.com',
  'docusign.net',
  'venmo.com',
  'paypal.com',
  'stripe.com',
  'atlassian.net',
  'notion.so',
]);
const NOTIFIER_HOSTS = new Set(['accounts.google.com', 'calendar.google.com', 'docs.google.com', 'drive.google.com', 'google.com']);

// the tabs of gmail. the forums tab holds discussion lists, and the others hold machine mail.
const MACHINE_TABS = ['CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];

// the people the owner wrote to, read from the To and Cc headers of the owner's sent mail, as mailbox forms.
export function contactsOf(sent: readonly gmail_v1.Schema$Message[]): Set<string> {
  const out = new Set<string>();
  for (const message of sent) {
    for (const name of ['To', 'Cc']) for (const address of addressesOf(header(message, name))) out.add(mailboxOf(address));
  }
  return out;
}

// independentKindOf gives the kind of a mail from three plain facts: a sender the owner wrote to is a person, a sender
// of a known notifier is automated, and the tab of gmail decides the rest. null when none of them applies.
export function independentKindOf(message: gmail_v1.Schema$Message, contacts: ReadonlySet<string>, owner: ReadonlySet<string>): MailKind | null {
  const from = fromAddress(header(message, 'From'));
  if (!from) return null;
  const mailbox = mailboxOf(from);
  if (contacts.has(mailbox) && ![...owner].some((each) => mailboxOf(each) === mailbox)) return 'person';
  const host = from.slice(from.lastIndexOf('@') + 1);
  if (NOTIFIER_HOSTS.has(host) || NOTIFIER_DOMAINS.has(registrableDomain(host))) return 'automated';
  const labels = message.labelIds ?? [];
  if (labels.includes('CATEGORY_FORUMS')) return 'list';
  if (labels.some((each) => MACHINE_TABS.includes(each))) return 'automated';
  return null;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// statesDay is true when the words name the day (yyyy-mm-dd) in one of the plain forms that mail uses: the iso day,
// "10/24", "Oct 24", "October 24th", "24 Oct", a weekday of the week after the mail, or "today", "tonight", "eod" and
// "tomorrow" next to the day of the mail. it is a plain search of the forms, without the parser of deadlines.ts.
export function statesDay(words: string, day: string, sentAt: string, timeZone: string): boolean {
  const text = words.toLowerCase().replace(/\s+/g, ' ');
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const name = MONTH_NAMES[month - 1]!;
  const forms = [
    escape(day),
    `0?${month}/0?${date}(?:/(?:${year}|${year.slice(2)}))?`,
    `(?:${name}|${name.slice(0, 3)}\\.?|${name.slice(0, 4)}\\.?)\\s{0,2}0?${date}(?:st|nd|rd|th)?`,
    `0?${date}(?:st|nd|rd|th)?\\s{0,2}(?:of\\s)?(?:${name}|${name.slice(0, 3)}\\.?)`,
  ];
  // a number form ends on a word edge, so "Oct 2" is not found in "Oct 24".
  if (forms.some((form) => new RegExp(`(?<![\\p{L}\\p{N}])${form}(?![\\p{N}])`, 'u').test(text))) return true;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return false;
  let base: string;
  try {
    base = localDay(new Date(sent), timeZone);
  } catch {
    return false;
  }
  if (day === base && /\b(?:today|tonight|eod|end of (?:the )?day)\b/.test(text)) return true;
  if (day === addDays(base, 1) && /\b(?:tomorrow|tmrw)\b/.test(text)) return true;
  for (let ahead = 0; ahead <= 13; ahead++) {
    if (addDays(base, ahead) !== day) continue;
    const weekday = WEEKDAY_NAMES[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
    return new RegExp(`\\b(?:${weekday}|${weekday.slice(0, 3)})\\b`).test(text);
  }
  return false;
}
