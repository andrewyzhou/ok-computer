import type { AutonomyDomain } from '../src/dashboard/autonomy-types.js';
import type { Risk } from '../src/policy/policy.js';

// the calls of the existing tools that the tests of the trust ladder share. risk and alwaysApprove are what the tool
// caller computes for the call today (src/tools/caller.ts: riskFor, then needsApproval or an external riskFor). domain
// is the domain that domainOf must give, or null for a call outside the ladder. the equivalence test decides each call
// in each session kind and with each rule set, once without the ladder and once with the default levels, and the two
// verdicts must be the same.
export interface LadderCall {
  name: string;
  tool: string;
  risk: Risk;
  alwaysApprove: boolean;
  input: Record<string, unknown>;
  domain: AutonomyDomain | null;
}

const account = 'personal';

export const LADDER_CALLS: readonly LadderCall[] = [
  {
    name: 'a gmail draft',
    tool: 'google__gmail_draft',
    risk: 'write',
    alwaysApprove: false,
    input: { account, to: ['ana@example.com'], subject: 'Thursday', body: 'Thursday at 3 works for me.' },
    domain: 'mail_drafts',
  },
  {
    name: 'an inbox draft reply',
    tool: 'inbox_draft_reply',
    risk: 'write',
    alwaysApprove: false,
    input: { account, sourceMessageId: 'm-1', threadId: 't-1', to: ['ana@example.com'], subject: 'Re: Thursday', body: 'Thursday works.' },
    domain: 'mail_drafts',
  },
  { name: 'a gmail label', tool: 'google__gmail_label', risk: 'write', alwaysApprove: false, input: { account, messageIds: ['m-1'], add: ['Label_1'], remove: [] }, domain: 'mail_labels' },
  { name: 'a gmail archive', tool: 'google__gmail_archive', risk: 'write', alwaysApprove: false, input: { account, messageIds: ['m-1', 'm-2'] }, domain: 'mail_labels' },
  { name: 'a gmail mark read', tool: 'google__gmail_mark_read', risk: 'write', alwaysApprove: false, input: { account, messageIds: ['m-1'] }, domain: 'mail_labels' },
  {
    name: 'a calendar hold',
    tool: 'google__calendar_create_event',
    risk: 'write',
    alwaysApprove: false,
    input: { account, summary: 'Focus', start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T11:00:00-07:00' },
    domain: 'calendar_holds',
  },
  {
    name: 'a calendar hold with an empty guest list',
    tool: 'google__calendar_create_event',
    risk: 'write',
    alwaysApprove: false,
    input: { account, summary: 'Focus', start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T11:00:00-07:00', attendees: [] },
    domain: 'calendar_holds',
  },
  {
    name: 'a calendar event with guests',
    tool: 'google__calendar_create_event',
    risk: 'external',
    alwaysApprove: true,
    input: { account, summary: 'Check-in', start: '2026-10-20T15:00:00-07:00', end: '2026-10-20T15:30:00-07:00', attendees: ['ana@example.com'] },
    domain: 'calendar_guests',
  },
  {
    name: 'a browser submit',
    tool: 'browser_submit',
    risk: 'external',
    alwaysApprove: true,
    input: { url: 'https://example.com/signup', button: 'Sign up', fields: { email: 'owner@example.com' } },
    domain: 'browser_submits',
  },
  {
    name: 'a checkout submit',
    tool: 'browser_submit',
    risk: 'external',
    alwaysApprove: true,
    input: { url: 'https://shop.example/checkout', button: 'Place order', fields: { quantity: '1', payment: 'saved card ending 4242' } },
    domain: 'purchases',
  },
  {
    name: 'a card form submit',
    tool: 'browser_submit',
    risk: 'external',
    alwaysApprove: true,
    input: { url: 'https://example.com/account', button: 'Save', fields: { 'cc-number': '4111 1111 1111 1111', 'cc-exp': '12/29' } },
    domain: 'purchases',
  },
  { name: 'a script button outside a form', tool: 'browser_submit', risk: 'external', alwaysApprove: true, input: { url: 'https://shop.example/p/1', button: 'Add', fields: {} }, domain: 'purchases' },
  // the paid flows that the review probe found outside purchases.
  ...(
    [
      ['a room booking', { url: 'https://hotel.example/rooms/12/booking', button: 'Book now', fields: { guests: '2', name: 'Ana', email: 'ana@example.com' } }],
      ['a reservation', { url: 'https://inn.example/reserve', button: 'Reserve', fields: { nights: '3', note: 'late arrival' } }],
      ['a checkout with a plural path', { url: 'https://shop.example/checkouts/c/abc', button: 'Complete', fields: { note: 'x' } }],
      ['a last step that confirms', { url: 'https://shop.example/step/3', button: 'Confirm', fields: { delivery: 'standard', gift_message: 'hi' } }],
      ['a flight booking', { url: 'https://air.example/flights/confirm', button: 'Book flight', fields: { passenger: 'Ana' } }],
      ['event tickets', { url: 'https://events.example/event/9', button: 'Get tickets', fields: { quantity: '2' } }],
      ['a submit that the agent marks as a purchase', { url: 'https://example.com/signup', button: 'Sign up', fields: { email: 'owner@example.com' }, purchase: true }],
    ] as const
  ).map(([name, input]): LadderCall => ({ name, tool: 'browser_submit', risk: 'external', alwaysApprove: true, input, domain: 'purchases' })),
  {
    name: 'a gmail unsubscribe',
    tool: 'google__gmail_unsubscribe',
    risk: 'external',
    alwaysApprove: true,
    input: { account, messageId: 'm-1', sender: 'news@example.com', target: 'https://example.com/unsubscribe' },
    domain: 'unsubscribes',
  },
  {
    name: 'an inbox unsubscribe',
    tool: 'inbox_unsubscribe',
    risk: 'external',
    alwaysApprove: true,
    input: { senderId: 1, account, sender: 'News', fromAddress: 'news@example.com', method: 'one_click', target: 'https://example.com/u' },
    domain: 'unsubscribes',
  },
  {
    name: 'code with network access',
    tool: 'sandbox_exec',
    risk: 'external',
    alwaysApprove: true,
    input: { language: 'python', code: 'print(1)', network: { allow: ['pypi.org'] } },
    domain: 'sandbox_network',
  },
  { name: 'code without network access', tool: 'sandbox_exec', risk: 'exec', alwaysApprove: false, input: { language: 'python', code: 'print(1)' }, domain: null },
  {
    name: 'a calendar update',
    tool: 'google__calendar_update_event',
    risk: 'external',
    alwaysApprove: true,
    input: { account, eventId: 'e-1', summary: 'Moved' },
    domain: null,
  },
  {
    name: 'a calendar update with guests',
    tool: 'google__calendar_update_event',
    risk: 'external',
    alwaysApprove: true,
    input: { account, eventId: 'e-1', currentTitle: 'Check-in', attendees: ['ana@example.com', 'bo@example.com'] },
    domain: 'calendar_guests',
  },
  {
    name: 'a calendar update with an empty guest list',
    tool: 'google__calendar_update_event',
    risk: 'external',
    alwaysApprove: true,
    input: { account, eventId: 'e-1', currentTitle: 'Check-in', summary: 'Moved', attendees: [] },
    domain: null,
  },
  { name: 'a calendar delete', tool: 'google__calendar_delete_event', risk: 'external', alwaysApprove: true, input: { account, eventId: 'e-1' }, domain: null },
  {
    name: 'a gmail send',
    tool: 'google__gmail_send',
    risk: 'external',
    alwaysApprove: true,
    input: { account, to: ['ana@example.com'], subject: 'Hi', body: 'Hi' },
    domain: null,
  },
  {
    name: 'an inbox archive of a sender',
    tool: 'inbox_archive_sender',
    risk: 'write',
    alwaysApprove: true,
    input: { senderId: 1, account, sender: 'News', olderThanDays: 30 },
    domain: null,
  },
  {
    name: 'an inbox event from a proposal',
    tool: 'inbox_create_event',
    risk: 'write',
    alwaysApprove: true,
    input: { account, proposalId: 1, summary: 'Dentist', startAt: '2026-10-21T09:00:00-07:00', endAt: null, allDay: false, description: null },
    domain: null,
  },
  { name: 'an inbox cancel of a subscription', tool: 'inbox_cancel_subscription', risk: 'external', alwaysApprove: true, input: { subscriptionId: 1 }, domain: null },
  { name: 'a browser allow domain', tool: 'browser_allow_domain', risk: 'external', alwaysApprove: true, input: { domain: 'example.com' }, domain: null },
  { name: 'a browser click', tool: 'browser_click', risk: 'write', alwaysApprove: false, input: { ref: 'e1' }, domain: null },
  { name: 'a web fetch', tool: 'web_fetch', risk: 'read', alwaysApprove: false, input: { url: 'https://example.com/a?q=1' }, domain: null },
  { name: 'a web search', tool: 'web_search', risk: 'read', alwaysApprove: false, input: { query: 'weather' }, domain: null },
  { name: 'a memory write', tool: 'memory_write', risk: 'write', alwaysApprove: false, input: { path: 'notes.md', content: 'x' }, domain: null },
  { name: 'a message to the owner', tool: 'message_owner', risk: 'write', alwaysApprove: false, input: { text: 'done' }, domain: null },
  { name: 'an integration write', tool: 'slack_send_message', risk: 'external', alwaysApprove: false, input: { channel: 'C1', text: 'hi' }, domain: null },
];

// the write tools of the desk, the docs and the people memory of phase 6, which came after the golden file of the
// engine from before the ladder. the policy of master has no rule for them, so they are not in LADDER_CALLS and its
// golden file. the equivalence test decides them at the default level and without the ladder, and the two verdicts
// must be the same, so their default levels keep the behavior that the merged tracks gave them.
export const PHASE6_LADDER_CALLS: readonly LadderCall[] = [
  {
    name: 'a nudge draft of a delegation',
    tool: 'desk_draft_nudge',
    risk: 'write',
    alwaysApprove: false,
    input: {
      account,
      delegationId: 1,
      threadId: 't-1',
      followUpAt: '2026-10-20T09:00:00-07:00',
      to: ['ana@example.com'],
      subject: 'Re: the lease',
      body: 'Any news on the signed lease?',
    },
    domain: 'mail_drafts',
  },
  { name: 'a delegation create', tool: 'delegation_create', risk: 'write', alwaysApprove: false, input: { title: 'Book the Denver flights' }, domain: 'delegations' },
  { name: 'a delegation update', tool: 'delegation_update', risk: 'write', alwaysApprove: false, input: { id: 1, nextStep: 'Pick a seat' }, domain: 'delegations' },
  {
    name: 'a delegation wait',
    tool: 'delegation_wait_on',
    risk: 'write',
    alwaysApprove: false,
    input: { id: 1, waitingOn: { name: 'Ana', email: 'ana@example.com' } },
    domain: 'delegations',
  },
  { name: 'a delegation done', tool: 'delegation_done', risk: 'write', alwaysApprove: false, input: { id: 1 }, domain: 'delegations' },
  { name: 'a doc write', tool: 'doc_write', risk: 'write', alwaysApprove: false, input: { title: 'Trip plan', kind: 'plan', body: '# Trip' }, domain: 'local_writes' },
  { name: 'a doc update', tool: 'doc_update', risk: 'write', alwaysApprove: false, input: { id: 1, baseVersion: 1, body: '# Trip v2' }, domain: 'local_writes' },
  { name: 'a person note', tool: 'person_note', risk: 'write', alwaysApprove: false, input: { person: 'ana@example.com', text: 'prefers mornings', kind: 'preference' }, domain: 'local_writes' },
  { name: 'a delegation list', tool: 'delegation_list', risk: 'read', alwaysApprove: false, input: {}, domain: null },
];

// the sessions that the equivalence test decides each call in: the owner chat, an automation, a sub-agent, and a
// tainted owner chat (the taint list is given with the call).
export const LADDER_SESSIONS = [
  { name: 'owner chat', sessionKey: 'main', taint: [] as string[] },
  { name: 'automation', sessionKey: 'automation:a-1', taint: [] as string[] },
  { name: 'sub-agent', sessionKey: 'sub:research:run-9', taint: [] as string[] },
  { name: 'tainted owner chat', sessionKey: 'main', taint: ['gmail: a mail from news@example.com'] },
] as const;
