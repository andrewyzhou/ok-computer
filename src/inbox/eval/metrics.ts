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
  messages: number;
  // the read mail of each kind, from classifyMail.
  person: number;
  list: number;
  automated: number;
  items: number;
  needsReply: number;
  // needs_reply items whose mail is not a person mail. the bar is 0.
  automatedInNeedsReply: number;
  // true when every needs_reply item comes before every other item.
  needsReplyFirst: boolean;
  // automated mail with no deadline, bill or package that the digest still shows. the bar is 0.
  automatedShown: number;
  // with a labels file: the share of the labelled needs_reply mail that the digest put in needs_reply, and the share of
  // the needs_reply items that the labels agree with.
  needsReplyRecall: Rate;
  needsReplyPrecision: Rate;
}

export interface SubscriptionMetrics {
  receipts: number;
  // receipts of each kind, from receiptKindOf.
  kinds: Record<'charge' | 'refund' | 'order' | 'other', number>;
  subscriptions: number;
  // the share of the receipt rows whose amount is in the text of the receipt. the bar is 1.
  amountInText: Rate;
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
  // the due dates that the model gave, the ones that passed checkDue, and the drops by reason.
  given: number;
  kept: number;
  dropped: Record<string, number>;
  // kept due dates whose words are not in the mail, or name another day. the bar is 0.
  unsupported: number;
  // kept due dates before the time of the mail.
  beforeMail: number;
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
  refused: string[];
  // the checks of the bars above that failed, as short sentences.
  failures: string[];
}

// failuresOf gives a sentence for each bar of the report that is not met.
export function failuresOf(_report: Omit<EvalReport, 'failures'>): string[] {
  throw new Error('not built: failuresOf (work package eval)');
}

// formatReport gives the report as text for a terminal: one block for each job and one line for each metric.
export function formatReport(_report: EvalReport): string {
  throw new Error('not built: formatReport (work package eval)');
}
