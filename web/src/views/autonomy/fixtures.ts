import type {
  AutonomyChangeRow,
  AutonomyDomain,
  AutonomyDomainView,
  AutonomyLevel,
  AutonomyPage,
} from '../../../../src/dashboard/autonomy-types';

// the answers of the autonomy endpoints for the tests and the screenshots. the texts are the ones of DOMAINS in
// src/policy/autonomy.ts, so a shot looks like the real page.

export const LEVEL_TEXT: Record<AutonomyLevel, string> = {
  ask: 'You approve each action before it happens.',
  review: 'A second model checks each action and lets it through or holds it. You see every action in the activity and the trace.',
  auto: 'The agent acts on its own. You see every action in the activity and the trace.',
};

const ALL: AutonomyLevel[] = ['ask', 'review', 'auto'];

function domain(
  id: AutonomyDomain,
  label: string,
  explanation: string,
  tools: string[],
  defaultLevel: AutonomyLevel,
  maxLevel: AutonomyLevel,
  fixedReason: string | null = null,
): AutonomyDomainView {
  return {
    id,
    label,
    explanation,
    tools,
    level: defaultLevel,
    defaultLevel,
    maxLevel,
    levels: ALL.slice(0, ALL.indexOf(maxLevel) + 1),
    fixed: fixedReason !== null,
    fixedReason,
    updatedAt: null,
    changeId: null,
    overriddenBy: null,
  };
}

// every domain at its default level, as on a new install.
export const DEFAULT_DOMAINS: AutonomyDomainView[] = [
  domain(
    'mail_drafts',
    'Mail drafts',
    'Save a reply or a new mail as a draft in Gmail. A draft is never sent. You send it yourself.',
    ['google__gmail_draft', 'inbox_draft_reply'],
    'review',
    'auto',
  ),
  domain(
    'mail_labels',
    'Mail labels and archive',
    'Add or remove labels, mark mail as read, and take mail out of the inbox. Nothing is deleted, and archived mail stays in All Mail.',
    ['google__gmail_label', 'google__gmail_archive', 'google__gmail_mark_read'],
    'review',
    'auto',
  ),
  domain('calendar_holds', 'Calendar holds', 'Put a block of time on your own calendar, with no guests. Nobody else gets an invitation.', ['google__calendar_create_event'], 'review', 'auto'),
  domain(
    'calendar_guests',
    'Calendar events with guests',
    'Create an event that invites other people. Google sends each guest an invitation in your name.',
    ['google__calendar_create_event', 'google__calendar_update_event'],
    'ask',
    'ask',
    'An invitation goes to other people in your name, so you approve each one.',
  ),
  domain(
    'browser_submits',
    'Browser form submits',
    'Send a form on a web page in the agent browser, for example a sign-up or a search form. A submit that looks like a purchase is in Purchases and always asks you. A page that the agent read makes each submit ask you anyway. A sub-agent never sends a form on its own.',
    ['browser_submit'],
    'ask',
    'review',
  ),
  domain(
    'unsubscribes',
    'Unsubscribes',
    'Leave a mailing list with its unsubscribe link.',
    ['google__gmail_unsubscribe', 'inbox_unsubscribe'],
    'ask',
    'ask',
    'An unsubscribe cannot be taken back, so it always waits for you.',
  ),
  domain(
    'sandbox_network',
    'Code with network access',
    'Run code in the sandbox that can reach the web sites on its allow list. A page or a mail that the agent read makes each such run ask you anyway. A sub-agent never runs such code on its own.',
    ['sandbox_exec'],
    'ask',
    'review',
  ),
  domain(
    'purchases',
    'Purchases',
    'Pay for anything, in any way. A form submit in the agent browser counts as a purchase when its page, its button or its fields name an order, a payment, a cart, a checkout or a card, and so does a button that sends data with a script outside a form.',
    ['browser_submit'],
    'ask',
    'ask',
    'Money leaves your account, so you approve each payment.',
  ),
];

// the first run: every level is the default, and the history is empty.
export const firstRun: AutonomyPage = { domains: DEFAULT_DOMAINS, levelText: LEVEL_TEXT, history: [], before: null };

// the owner raised drafts and labels on the dashboard, then asked in chat to lower labels again.
export const history: AutonomyChangeRow[] = [
  {
    id: 3,
    domain: 'mail_labels',
    fromLevel: 'auto',
    toLevel: 'review',
    actor: 'agent',
    via: 'chat',
    runId: 'run-12',
    toolCallId: 'call-1',
    sessionKey: 'main',
    note: 'The owner asked to check labels again after a wrong archive.',
    taint: [],
    createdAt: '2026-10-18T17:05:00.000Z',
  },
  {
    id: 2,
    domain: 'mail_labels',
    fromLevel: 'review',
    toLevel: 'auto',
    actor: 'owner',
    via: 'dashboard',
    runId: null,
    toolCallId: null,
    sessionKey: null,
    note: null,
    taint: [],
    createdAt: '2026-10-17T16:00:00.000Z',
  },
  {
    id: 1,
    domain: 'mail_drafts',
    fromLevel: 'review',
    toLevel: 'auto',
    actor: 'owner',
    via: 'dashboard',
    runId: null,
    toolCallId: null,
    sessionKey: null,
    note: null,
    taint: [],
    createdAt: '2026-10-17T15:58:00.000Z',
  },
];

const changed = (id: AutonomyDomain, level: AutonomyLevel, change: AutonomyChangeRow): AutonomyDomainView => ({
  ...DEFAULT_DOMAINS.find((each) => each.id === id)!,
  level,
  updatedAt: change.createdAt,
  changeId: change.id,
});

// a full state: two domains were changed, and the history has a change from chat.
export const full: AutonomyPage = {
  domains: DEFAULT_DOMAINS.map((each) =>
    each.id === 'mail_drafts' ? changed('mail_drafts', 'auto', history[2]!) : each.id === 'mail_labels' ? changed('mail_labels', 'review', history[0]!) : each,
  ),
  levelText: LEVEL_TEXT,
  history,
  before: null,
};
