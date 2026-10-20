// the quality metrics of the inbox jobs on real mail. the read-only check (scripts/eval/inbox.ts) fills them and prints
// them, so the quality can be measured again after each change. the metrics hold counts, rates and the shapes of the
// mail, never a body, a subject or an address. the work package "eval" builds the functions; the shapes are fixed
// here so the other packages know what their part is measured by.

// a rate is a share from 0 to 1, or null when its base is 0.
export type Rate = number | null;

export interface AccountCoverage {
  alias: string;
  // false when the check could not read the account; error says why.
  read: boolean;
  error: string | null;
  // the messages that each job listed and the most it reads. capped is true when the account has more.
  digest: { listed: number; limit: number; capped: boolean };
  subscriptions: { listed: number; limit: number; capped: boolean };
  newsletters: { listed: number; limit: number; capped: boolean };
  // the share of the read messages with no text/plain part.
  htmlOnly: Rate;
}

export interface DigestMetrics {
  // true when the digest ran with its model calls. without them the digest has no items, so the item counts are 0.
  models: boolean;
  messages: number;
  // the read mail of each kind, from classifyMail.
  person: number;
  list: number;
  automated: number;
  items: number;
  needsReply: number;
  // needs_reply items whose mail the plain view of independent.ts calls automated (a known notifier, or a machine tab of
  // gmail without a sender the owner wrote to). the view does not use classifyMail, so a fault of it shows here. the
  // bar is 0.
  automatedInNeedsReply: number;
  // true when every needs_reply item comes before every other item.
  needsReplyFirst: boolean;
  // mail that the plain view calls automated and that the digest still shows without a deadline, a bill or a package.
  // the bar is 0.
  automatedShown: number;
  // the read mail that the plain view gives a kind, and the mail of those where it and classifyMail disagree about
  // whether a person wrote it.
  checked: number;
  disagreements: number;
  // true when the check had a labels file. without one the recall and the precision are not measured.
  labels: boolean;
  // with a labels file: the share of the labelled needs_reply mail that the digest put in needs_reply, and the share of
  // the needs_reply items that the labels agree with.
  needsReplyRecall: Rate;
  needsReplyPrecision: Rate;
  // with a labels file: the share of the labelled mail whose kind classifyMail got right.
  kindAccuracy: Rate;
  // the read mail that has a label.
  labelled: number;
}

export interface SubscriptionMetrics {
  // true when the scan ran with its model calls, so the subscriptions are the rows that the scan wrote. without them
  // the check groups the charges in code (merchantOf and judgeSubscription).
  models: boolean;
  receipts: number;
  // receipts of each kind, from receiptKindOf.
  kinds: Record<'charge' | 'refund' | 'order' | 'other', number>;
  subscriptions: number;
  // the share of the receipt rows whose amount is in the text of the receipt. the bar is 1. null without models,
  // because then the code reads each amount from the text itself.
  amountInText: Rate;
  // the share of the charges in which amountsIn finds an amount.
  amountFound: Rate;
  // subscriptions whose stated cadence and gap cadence disagree.
  cadenceConflicts: number;
  // subscriptions with an unknown cadence.
  unknownCadence: number;
  // subscriptions whose receipts come from more than one registrable domain.
  mixedDomains: number;
  // the subscriptions in each confidence band: below 0.5, 0.5 to 0.8, and 0.8 or more.
  confidence: { low: number; middle: number; high: number };
  // with a labels file: the share of the labelled subscriptions with the right merchant, amount and cadence.
  merchantAccuracy: Rate;
  amountAccuracy: Rate;
  cadenceAccuracy: Rate;
  // the subscriptions by merchant name. the check fills it only with --names, because a name comes from mail.
  merchants?: MerchantLine[];
}

export interface MerchantLine {
  account: string;
  merchant: string;
  amount: number | null;
  currency: string | null;
  cadence: string;
  confidence: number;
}

export interface NewsletterMetrics {
  messages: number;
  senders: number;
  // sender groups that hold more than one registrable from domain, or more than one display name. the bar for the
  // domains is 0.
  mixedDomains: number;
  mixedNames: number;
  // the senders of each unsubscribe method.
  methods: Record<'one_click' | 'https' | 'mailto' | 'none', number>;
  // senders whose stored link is not one of the targets of their header, which the tool would refuse. the bar is 0.
  linkNotInHeader: number;
  // senders with a one-click or https link whose newest link is not signed by the from domain.
  unsigned: number;
}

export interface DeadlineMetrics {
  // true when the digest ran with its model calls. the due dates come from the model, so without it the counts of
  // the given dates are 0, and only the dates that findDates finds in the mail are counted.
  models: boolean;
  // the digest mail that findDates read, the dates it found, and the mail with at least one date.
  mails: number;
  mentions: number;
  mailsWithDates: number;
  // the due dates that the model gave, the ones that passed checkDue, and the drops by reason.
  given: number;
  kept: number;
  dropped: Record<string, number>;
  // kept due dates whose words are not in the mail, or name another day. the bar is 0.
  unsupported: number;
  // kept due dates before the time of the mail.
  beforeMail: number;
  // with a labels file: the share of the labelled mail whose kept due day (or no due day) matches the label.
  dueAccuracy: Rate;
}

export interface EvalReport {
  at: string;
  // the version of the code (git commit) and the model chain of each slot, so two reports can be compared.
  commit: string | null;
  models: Record<string, string[]>;
  accounts: AccountCoverage[];
  digest: DigestMetrics | null;
  subscriptions: SubscriptionMetrics | null;
  newsletters: NewsletterMetrics | null;
  deadlines: DeadlineMetrics | null;
  // the calls that the read-only view refused. a job that tried to change an account shows here. the bar is empty.
  // it lists the refusals of google first and then the tool calls that the dry caller refused, as "tool <name>".
  refused: string[];
  // the two parts of refused. a refused tool call is expected: the digest asks for drafts and proposals, and the dry
  // caller refuses each of them, so only a google refusal fails the bar.
  refusedGoogle: string[];
  refusedTools: string[];
  // the checks of the bars above that failed, as short sentences.
  failures: string[];
}

// the text that a failure line or a report line may hold. an error text or a refused call can quote a link or an
// address from mail, so both are replaced.
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<link>')
    .replace(/\bmailto:\S+/gi, '<link>')
    .replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, '<address>')
    .replace(/\s+/g, ' ')
    .trim();
}

const percent = (rate: Rate) => (rate === null ? 'n/a' : `${Math.round(rate * 1000) / 10}%`);

// failuresOf gives a sentence for each bar of the report that is not met.
export function failuresOf(report: Omit<EvalReport, 'failures'>): string[] {
  const out: string[] = [];
  const { digest, subscriptions, newsletters, deadlines } = report;
  if (digest) {
    if (digest.automatedInNeedsReply > 0) out.push(`digest: ${digest.automatedInNeedsReply} needs-reply items come from mail that no person wrote (the bar is 0).`);
    if (digest.checked > 0 && digest.disagreements / digest.checked > 0.1) out.push(`digest: classifyMail and the plain view disagree on ${digest.disagreements} of ${digest.checked} mails (the bar is 10%).`);
    if (digest.automatedShown > 0) out.push(`digest: ${digest.automatedShown} automated mails without a deadline, a bill or a package are shown (the bar is 0).`);
    if (!digest.needsReplyFirst) out.push('digest: a needs-reply item comes after an item of another section.');
  }
  if (subscriptions && subscriptions.amountInText !== null && subscriptions.amountInText < 1) {
    out.push(`subscriptions: ${percent(subscriptions.amountInText)} of the receipt amounts are in the text of the receipt (the bar is 100%).`);
  }
  if (newsletters) {
    if (newsletters.mixedDomains > 0) out.push(`newsletters: ${newsletters.mixedDomains} sender groups hold more than one from domain (the bar is 0).`);
    if (newsletters.linkNotInHeader > 0) out.push(`newsletters: ${newsletters.linkNotInHeader} senders have a link that is not in their header (the bar is 0).`);
  }
  if (deadlines) {
    if (deadlines.unsupported > 0) out.push(`deadlines: ${deadlines.unsupported} kept due dates are not stated in the mail (the bar is 0).`);
    if (deadlines.beforeMail > 0) out.push(`deadlines: ${deadlines.beforeMail} kept due dates are before the mail (the bar is 0).`);
  }
  if (report.refusedGoogle.length) {
    out.push(`google: the read-only view refused ${report.refusedGoogle.length} calls (${[...new Set(report.refusedGoogle.map(scrub))].join(', ')}). the bar is none.`);
  }
  return out;
}

type Line = readonly [name: string, value: string | number | boolean];

const valueOf = (value: string | number | boolean) => (typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value));

// block gives a title and its lines, with the values in one column.
function block(title: string, lines: readonly Line[]): string {
  const width = Math.max(0, ...lines.map(([name]) => name.length));
  return [title, ...lines.map(([name, value]) => `  ${name.padEnd(width)}  ${valueOf(value)}`)].join('\n');
}

const count = (each: { listed: number; limit: number; capped: boolean }) => `${each.listed} of ${each.limit}${each.capped ? ' (capped)' : ''}`;

// the state of a job without metrics: its check failed, or the run left it out.
function missing(report: EvalReport, job: string): string {
  if (report.failures.some((each) => each.startsWith(`${job}: `))) return 'failed, see the failures';
  return 'not run';
}

// a rate that needs labels, or the words that say it was not measured.
const labelled = (metrics: DigestMetrics, rate: Rate) => (metrics.labels ? percent(rate) : 'not measured (no labels)');

function digestBlock(metrics: DigestMetrics): string {
  return block('digest', [
    ['models', metrics.models ? 'on' : 'off'],
    ['messages', metrics.messages],
    ['person', metrics.person],
    ['list', metrics.list],
    ['automated', metrics.automated],
    ['items', metrics.items],
    ['needs reply', metrics.needsReply],
    ['automated in needs reply', metrics.automatedInNeedsReply],
    ['needs reply first', metrics.needsReplyFirst],
    ['automated shown', metrics.automatedShown],
    ['kind checked', metrics.checked],
    ['kind disagreements', metrics.disagreements],
    ['labelled', metrics.labelled],
    ['needs reply recall', labelled(metrics, metrics.needsReplyRecall)],
    ['needs reply precision', labelled(metrics, metrics.needsReplyPrecision)],
    ['kind accuracy', labelled(metrics, metrics.kindAccuracy)],
  ]);
}

function subscriptionBlock(metrics: SubscriptionMetrics): string {
  const lines: Line[] = [
    ['models', metrics.models ? 'on' : 'off'],
    ['receipts', metrics.receipts],
    ['charge', metrics.kinds.charge],
    ['refund', metrics.kinds.refund],
    ['order', metrics.kinds.order],
    ['other', metrics.kinds.other],
    ['subscriptions', metrics.subscriptions],
    ['amount in text', percent(metrics.amountInText)],
    ['amount found', percent(metrics.amountFound)],
    ['cadence conflicts', metrics.cadenceConflicts],
    ['unknown cadence', metrics.unknownCadence],
    ['mixed domains', metrics.mixedDomains],
    ['confidence below 0.5', metrics.confidence.low],
    ['confidence 0.5 to 0.8', metrics.confidence.middle],
    ['confidence 0.8 or more', metrics.confidence.high],
    ['merchant accuracy', percent(metrics.merchantAccuracy)],
    ['amount accuracy', percent(metrics.amountAccuracy)],
    ['cadence accuracy', percent(metrics.cadenceAccuracy)],
  ];
  const text = block('subscriptions', lines);
  if (!metrics.merchants?.length) return text;
  const rows = metrics.merchants.map((each): Line => {
    const amount = each.amount === null ? 'no amount' : `${each.amount.toFixed(2)} ${each.currency ?? ''}`.trim();
    return [`${each.account} ${scrub(each.merchant).slice(0, 60)}`, `${amount}, ${each.cadence}, ${percent(each.confidence)}`];
  });
  const width = Math.max(...rows.map(([name]) => name.length));
  return [text, '  merchants', ...rows.map(([name, value]) => `    ${name.padEnd(width)}  ${valueOf(value)}`)].join('\n');
}

function newsletterBlock(metrics: NewsletterMetrics): string {
  return block('newsletters', [
    ['messages', metrics.messages],
    ['senders', metrics.senders],
    ['mixed domains', metrics.mixedDomains],
    ['mixed names', metrics.mixedNames],
    ['one click', metrics.methods.one_click],
    ['https', metrics.methods.https],
    ['mailto', metrics.methods.mailto],
    ['none', metrics.methods.none],
    ['link not in header', metrics.linkNotInHeader],
    ['unsigned', metrics.unsigned],
  ]);
}

function deadlineBlock(metrics: DeadlineMetrics): string {
  const dropped = Object.entries(metrics.dropped)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([why, n]): Line => [`dropped ${why.replace(/_/g, ' ')}`, n]);
  return block('deadlines', [
    ['models', metrics.models ? 'on' : 'off'],
    ['mails', metrics.mails],
    ['dates in mail', metrics.mentions],
    ['mails with dates', metrics.mailsWithDates],
    ['given', metrics.given],
    ['kept', metrics.kept],
    ...dropped,
    ['unsupported', metrics.unsupported],
    ['before mail', metrics.beforeMail],
    ['due accuracy', percent(metrics.dueAccuracy)],
  ]);
}

// formatReport gives the report as text for a terminal: one block for each job and one line for each metric. it prints
// aliases, counts and rates. a merchant name shows only when the report holds the merchants, which --names asks for.
export function formatReport(report: EvalReport): string {
  const head = block('inbox quality check', [
    ['at', report.at],
    ['commit', report.commit ?? 'unknown'],
    ...Object.entries(report.models).map(([slot, chain]): Line => [`slot ${slot}`, chain.join(', ') || 'none']),
  ]);
  const width = Math.max(0, ...report.accounts.map((each) => each.alias.length));
  const accounts = [
    'accounts',
    ...report.accounts.map((each) => {
      const alias = each.alias.padEnd(width);
      const counts = `digest ${count(each.digest)}, subscriptions ${count(each.subscriptions)}, newsletters ${count(each.newsletters)}, html only ${percent(each.htmlOnly)}`;
      // a job that failed keeps the counts of the jobs before it, so a part that was read still shows.
      return each.read ? `  ${alias}  ${counts}` : `  ${alias}  ${counts}, not read: ${scrub(each.error ?? 'unknown error')}`;
    }),
  ].join('\n');
  const jobs = [
    report.digest ? digestBlock(report.digest) : `digest\n  ${missing(report, 'digest')}`,
    report.subscriptions ? subscriptionBlock(report.subscriptions) : `subscriptions\n  ${missing(report, 'subscriptions')}`,
    report.newsletters ? newsletterBlock(report.newsletters) : `newsletters\n  ${missing(report, 'newsletters')}`,
    report.deadlines ? deadlineBlock(report.deadlines) : `deadlines\n  ${missing(report, 'deadlines')}`,
  ];
  const refused = [
    'refused',
    `  google  ${report.refusedGoogle.length ? report.refusedGoogle.map(scrub).join(', ') : 'none'}`,
    `  tools   ${report.refusedTools.length ? summarize(report.refusedTools) : 'none'}`,
  ].join('\n');
  const failures = ['failures', ...(report.failures.length ? report.failures.map((each) => `  ${scrub(each)}`) : ['  none'])].join('\n');
  return [head, accounts, ...jobs, refused, failures].join('\n\n');
}

// the refused tool calls by name, with a count, for example "inbox_draft_reply x3".
function summarize(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${scrub(name)} x${n}` : scrub(name))).join(', ');
}
