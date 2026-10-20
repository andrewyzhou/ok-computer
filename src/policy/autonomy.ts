import type { AutonomyDomain, AutonomyLevel } from '../dashboard/autonomy-types.js';

// the trust ladder of phase 6 (docs/PHASE6-PLAN.md, track T6). each domain has one level on top of the policy engine.
// the default level of each domain gives the same decision as the policy engine gave before the ladder, so nothing
// gets more freedom until the owner raises a level on the dashboard. the store of the levels is autonomy-store.ts.

export type { AutonomyDomain, AutonomyLevel } from '../dashboard/autonomy-types.js';

// the order of trust. a higher index is more freedom.
export const LEVELS: readonly AutonomyLevel[] = ['ask', 'review', 'auto'];

export const levelRank = (level: AutonomyLevel): number => LEVELS.indexOf(level);

// the levels from ask up to and including max.
export const levelsUpTo = (max: AutonomyLevel): AutonomyLevel[] => LEVELS.slice(0, levelRank(max) + 1);

// a stored level above the most that a domain allows counts as that most. the store never writes such a level, so
// this only guards against a hand edit of the database.
export const clampLevel = (level: AutonomyLevel, max: AutonomyLevel): AutonomyLevel => (levelRank(level) > levelRank(max) ? max : level);

export const isLevel = (value: unknown): value is AutonomyLevel => typeof value === 'string' && (LEVELS as readonly string[]).includes(value);

export interface DomainSpec {
  id: AutonomyDomain;
  label: string;
  explanation: string;
  // the tools that the domain covers. domainOf decides the domain of one call, because the domain of some tools
  // depends on the input (an event with guests, code with network access).
  tools: readonly string[];
  // the level that gives the decisions of the policy engine before the ladder.
  defaultLevel: AutonomyLevel;
  maxLevel: AutonomyLevel;
  // a fixed domain stays at ask. the page shows the reason and no control.
  fixedReason: string | null;
}

export const LEVEL_TEXT: Record<AutonomyLevel, string> = {
  ask: 'You approve each action before it happens.',
  review: 'A second model checks each action and lets it through or holds it. You see every action in the activity and the trace.',
  auto: 'The agent acts on its own. You see every action in the activity and the trace.',
};

// the tools of each domain. a google tool has the prefix of the google integration ("google__").
const GOOGLE = (tool: string) => `google__${tool}`;

export const DOMAINS: readonly DomainSpec[] = [
  {
    id: 'mail_drafts',
    label: 'Mail drafts',
    explanation: 'Save a reply or a new mail as a draft in Gmail. A draft is never sent. You send it yourself.',
    tools: [GOOGLE('gmail_draft'), 'inbox_draft_reply'],
    defaultLevel: 'review',
    maxLevel: 'auto',
    fixedReason: null,
  },
  {
    id: 'mail_labels',
    label: 'Mail labels and archive',
    explanation: 'Add or remove labels, mark mail as read, and take mail out of the inbox. Nothing is deleted, and archived mail stays in All Mail.',
    tools: [GOOGLE('gmail_label'), GOOGLE('gmail_archive'), GOOGLE('gmail_mark_read')],
    defaultLevel: 'review',
    maxLevel: 'auto',
    fixedReason: null,
  },
  {
    id: 'calendar_holds',
    label: 'Calendar holds',
    explanation: 'Put a block of time on your own calendar, with no guests. Nobody else gets an invitation.',
    tools: [GOOGLE('calendar_create_event')],
    defaultLevel: 'review',
    maxLevel: 'auto',
    fixedReason: null,
  },
  {
    id: 'calendar_guests',
    label: 'Calendar events with guests',
    explanation: 'Create an event that invites other people. Google sends each guest an invitation in your name.',
    tools: [GOOGLE('calendar_create_event'), GOOGLE('calendar_update_event')],
    defaultLevel: 'ask',
    maxLevel: 'ask',
    fixedReason: 'An invitation goes to other people in your name, so you approve each one.',
  },
  {
    id: 'browser_submits',
    label: 'Browser form submits',
    explanation:
      'Send a form on a web page in the agent browser, for example a sign-up or a search form. A submit that looks like a purchase is in Purchases and always asks you. A page that the agent read makes each submit ask you anyway. A sub-agent never sends a form on its own.',
    tools: ['browser_submit'],
    defaultLevel: 'ask',
    maxLevel: 'review',
    fixedReason: null,
  },
  {
    id: 'unsubscribes',
    label: 'Unsubscribes',
    explanation: 'Leave a mailing list with its unsubscribe link.',
    tools: [GOOGLE('gmail_unsubscribe'), 'inbox_unsubscribe'],
    defaultLevel: 'ask',
    maxLevel: 'ask',
    fixedReason: 'An unsubscribe cannot be taken back, so it always waits for you.',
  },
  {
    id: 'sandbox_network',
    label: 'Code with network access',
    explanation:
      'Run code in the sandbox that can reach the web sites on its allow list. A page or a mail that the agent read makes each such run ask you anyway. A sub-agent never runs such code on its own.',
    tools: ['sandbox_exec'],
    defaultLevel: 'ask',
    maxLevel: 'review',
    fixedReason: null,
  },
  {
    id: 'purchases',
    label: 'Purchases',
    explanation:
      'Pay for anything, in any way. A form submit in the agent browser counts as a purchase when its page, its button or its fields name an order, a payment, a cart, a checkout or a card, and so does a button that sends data with a script outside a form.',
    tools: ['browser_submit'],
    defaultLevel: 'ask',
    maxLevel: 'ask',
    fixedReason: 'Money leaves your account, so you approve each payment.',
  },
];

export const DOMAIN_IDS: readonly AutonomyDomain[] = DOMAINS.map((each) => each.id);

export const isDomain = (value: unknown): value is AutonomyDomain => typeof value === 'string' && (DOMAIN_IDS as readonly string[]).includes(value);

export function domainSpec(id: AutonomyDomain): DomainSpec {
  const spec = DOMAINS.find((each) => each.id === id);
  if (!spec) throw new Error(`unknown autonomy domain ${id}`);
  return spec;
}

// the level of one call that the policy engine uses, and that the decision row keeps.
export interface AutonomyContext {
  domain: AutonomyDomain;
  level: AutonomyLevel;
}

// the domain of each tool whose domain does not depend on its input.
const FIXED_DOMAINS: Readonly<Record<string, AutonomyDomain>> = {
  [GOOGLE('gmail_draft')]: 'mail_drafts',
  inbox_draft_reply: 'mail_drafts',
  [GOOGLE('gmail_label')]: 'mail_labels',
  [GOOGLE('gmail_archive')]: 'mail_labels',
  [GOOGLE('gmail_mark_read')]: 'mail_labels',
  [GOOGLE('gmail_unsubscribe')]: 'unsubscribes',
  inbox_unsubscribe: 'unsubscribes',
};

// the words that make a browser submit a purchase. the text of the page address, the button and each field name and
// value is split into words first, so "cardNumber", "cc-exp" and "/checkout/pay" match too. the list is broad on
// purpose: a submit that it takes for a purchase by mistake asks the owner, which is the default of browser submits
// anyway, and a purchase that it misses could go out with only the reviewer's check.
const PURCHASE_WORDS =
  /\b(buy|buying|pay|paying|payment|payments|purchase|purchases|checkout|check out|order|orders|cart|basket|bag|billing|card|cards|credit|debit|cc|cvc|cvv|csc|cid|exp|expiry|expiration|iban|bic|swift|routing|subscribe|subscription|donate|donation|tip|wallet|invoice|price|total|amount|sum|coupon|promo)\b/i;

// a value with 13 to 19 digits, with or without spaces or dashes, can be a card number.
const CARD_NUMBER = /(?:\d[ -]?){12,18}\d/;

// the words of a text: a lower-case letter before an upper-case one, and a letter next to a digit, start a new word,
// and any other character than a letter or a digit splits words.
const wordsOf = (text: string): string =>
  text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)|(\d)([a-zA-Z])/g, '$1$3 $2$4')
    .replace(/[^a-zA-Z0-9]+/g, ' ');

// isPurchase tells whether a browser submit looks like a payment. a button outside a form sends what its script
// chooses, and the call names no field of it, so the owner approves it, the same as an "Add to cart" or a "Pay now".
export function isPurchase(fields: Record<string, unknown>): boolean {
  const formFields = fields.fields !== null && typeof fields.fields === 'object' ? (fields.fields as Record<string, unknown>) : {};
  const names = Object.keys(formFields);
  if (!names.length) return true;
  const values = Object.values(formFields).flatMap((value) => (Array.isArray(value) ? value : [value])).map(String);
  if (values.some((value) => CARD_NUMBER.test(value))) return true;
  const texts = [String(fields.url ?? ''), String(fields.button ?? ''), ...names, ...values];
  return texts.some((text) => PURCHASE_WORDS.test(wordsOf(text)));
}

// domainOf gives the domain of one call, or undefined for a call outside the ladder. the policy engine then decides
// it as before. calendar_create_event is a hold without attendees and an event with guests with them.
// calendar_update_event with a new attendee list sends each guest an update, so it is an event with guests. any other
// update and calendar_delete_event stay outside the ladder: they always ask the owner, and google tells the guests
// that the event already has. a browser submit that looks like a payment is a purchase, and any other is a browser
// submit. sandbox_exec is in sandbox_network only with network access. the tools of the dashboard flows
// (inbox_archive_sender, inbox_create_event, inbox_cancel_subscription) stay outside the ladder, because the dashboard
// asks the owner for each.
export function domainOf(tool: string, input: unknown): AutonomyDomain | undefined {
  if (Object.hasOwn(FIXED_DOMAINS, tool)) return FIXED_DOMAINS[tool];
  // an input that is not an object has no fields. the tool then fails its own check of the input.
  const fields = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (tool === GOOGLE('calendar_create_event')) {
    // any guest gets an invitation, so a list with an item is an event with guests. a missing or empty list is a hold.
    return Array.isArray(fields.attendees) && fields.attendees.length > 0 ? 'calendar_guests' : 'calendar_holds';
  }
  if (tool === GOOGLE('calendar_update_event')) return Array.isArray(fields.attendees) && fields.attendees.length > 0 ? 'calendar_guests' : undefined;
  if (tool === 'browser_submit') return isPurchase(fields) ? 'purchases' : 'browser_submits';
  if (tool === 'sandbox_exec') return fields.network !== null && typeof fields.network === 'object' ? 'sandbox_network' : undefined;
  return undefined;
}
