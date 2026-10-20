import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { gmail_v1 } from '@googleapis/gmail';
import { loadConfig } from '../../config/load.js';
import { SLOTS, type Config } from '../../config/schema.js';
import type { MailKind } from '../../dashboard/inbox-types.js';
import type { DigestItem, SubscriptionCadence } from '../../dashboard/types.js';
import type { Db } from '../../db/index.js';
import type { GoogleAccounts, GoogleApis } from '../../google/accounts.js';
import { bodyText, header } from '../../google/mime.js';
import { unsubscribeTargets, verifyUnsubscribeHeaders } from '../../google/unsubscribe.js';
import type { SlotRunner } from '../../models/slots.js';
import { redact } from '../../observability/redact.js';
import { cleanLine } from '../../signals/store.js';
import { headOf } from '../../text.js';
import { localDay, type Clock } from '../../time.js';
import { errorText } from '../../tools/registry.js';
import { ownerAddresses } from '../accounts.js';
import { classifyMail } from '../classify.js';
import { checkDue, findDates } from '../deadlines.js';
import type { DigestBatch } from '../context.js';
import { BODY_LIMIT as DIGEST_BODY, DIGEST_QUERY, MAX as DIGEST_MAX, runDigest } from '../digest.js';
import { getMessages, listMessages, readError, receivedAt } from '../gmail.js';
import { MAX as SWEEP_MAX, SIGNED, SWEEP_HEADERS, SWEEP_QUERY } from '../newsletters.js';
import { amountsIn, judgeSubscription, merchantOf, receiptKindOf, statedCadenceOf, type ChargeFact, type Merchant, type ReceiptKind, type StatedCadence } from '../receipts.js';
import { runJob } from '../run.js';
import { senderIdentityOf, unsubscribeChoiceOf } from '../senders.js';
import { cadenceOf, MAX as RECEIPT_MAX, MAX_AGE_DAYS as RECEIPT_DAYS, RECEIPT_QUERY, scanSubscriptions } from '../subscriptions.js';
import { dryContext, repoRoots } from './dry.js';
import { contactsOf, independentKindOf, statesDay } from './independent.js';
import { labelKey, loadLabels, type Labels } from './labels.js';
import {
  failuresOf,
  scrub,
  type AccountCoverage,
  type DeadlineMetrics,
  type DigestMetrics,
  type EvalReport,
  type MerchantLine,
  type NewsletterMetrics,
  type Rate,
  type SubscriptionMetrics,
} from './metrics.js';

// the read-only quality check of the inbox jobs on the owner's real mail. it opens a copy of the database, reads the
// accounts through readOnlyGoogle of ../readonly.ts, runs the parts of each job, and fills an EvalReport. it never
// writes to the owner's database, never saves a draft, never asks for an approval and never sends a message: the
// owner messenger, the tool caller and the agent of its context refuse every call.

export type EvalJob = 'digest' | 'subscriptions' | 'newsletters' | 'deadlines';

export interface EvalOptions {
  // the copy of the database, made with sqlite3 data/okc.sqlite ".backup <scratch>/okc.sqlite". the check refuses
  // the path of the live database.
  dbPath: string;
  // the config file to read. it is only read.
  configPath: string;
  // the accounts to check. the default is every account of the config.
  accounts?: string[];
  jobs: EvalJob[];
  // false runs only the checks in code, with no model call. true also runs the model calls of the jobs on the
  // configured slots, which costs money.
  models: boolean;
  // a json file of labels that the owner wrote, outside the repo (see labels.ts), or undefined.
  labelsPath?: string;
  // true puts the merchant names of the subscriptions in the report. a name comes from mail, so it is off by default.
  names?: boolean;
}

// the seams of the tests: the config, an open copy, the google accounts to wrap, a slot runner, a clock, the repo
// roots and the commit.
export interface EvalSeams {
  config?: Config;
  db?: Db;
  google?: GoogleAccounts;
  slots?: SlotRunner;
  clock?: Clock;
  roots?: string[];
  commit?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type JobState = { ok: true } | { ok: false; error: string };

// the facts of one mail of the digest: the kind from classifyMail, and the kind from the plain rules of
// independent.ts, or null when they have no opinion.
interface MailFact {
  kind: MailKind;
  check: MailKind | null;
}

// the sent mail of the last half year that the check reads for the people the owner wrote to.
const SENT_QUERY = 'in:sent newer_than:180d';
const SENT_MAX = 500;

// the facts of one receipt, from the functions of receipts.ts. amounts holds the numbers only, never the words.
interface ReceiptFact {
  account: string;
  id: string;
  at: string;
  kind: ReceiptKind;
  merchant: Merchant | null;
  amounts: Array<{ amount: number; currency: string }>;
  pick: { amount: number; currency: string } | null;
  stated: StatedCadence | null;
}

interface SenderGroup {
  domains: Set<string>;
  names: Set<string>;
  members: Array<{ message: gmail_v1.Schema$Message; at: string; fromAddress: string }>;
}

// one call of the digest model: the account, the text and the time of each input as the digest built them, and the
// items that the model gave.
interface DigestCall {
  account: string | null;
  inputs: Map<number, { text: string; sentAt: string }>;
  items: unknown[];
}

const rate = (hits: number, base: number): Rate => (base > 0 ? hits / base : null);
const short = (err: unknown) => scrub(redact(errorText(err))).slice(0, 200);
const coverage = (listed: number, limit: number) => ({ listed: Math.min(listed, limit), limit, capped: listed > limit });

// true when a part of the message is text/plain with a body.
function hasPlain(part: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!part) return false;
  if (part.mimeType === 'text/plain' && (part.body?.data || (part.body?.size ?? 0) > 0)) return true;
  return (part.parts ?? []).some(hasPlain);
}

// the display name of a from header, without its quotes, or the empty text.
function displayName(from: string): string {
  const angle = /^(.*?)<[^<>]*>\s*$/.exec(from);
  return angle ? angle[1]!.trim().replace(/^"(.*)"$/, '$1').trim() : '';
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

// the commit of the code, or null outside a git checkout.
function commitOf(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export async function runInboxEval(options: EvalOptions, seams: EvalSeams = {}): Promise<EvalReport> {
  let config = seams.config;
  if (!config) {
    const loaded = loadConfig(options.configPath);
    if (!loaded.ok) throw new Error(loaded.error);
    config = loaded.value;
  }
  const roots = seams.roots ?? repoRoots();
  const labels: Labels | null = options.labelsPath ? loadLabels(options.labelsPath, roots) : null;
  const dry = dryContext({
    dbPath: options.dbPath,
    config,
    configPath: options.configPath,
    models: options.models,
    roots,
    ...(options.accounts?.length ? { accounts: options.accounts } : {}),
    ...(seams.db ? { db: seams.db } : {}),
    ...(seams.google ? { google: seams.google } : {}),
    ...(seams.slots ? { slots: seams.slots } : {}),
    ...(seams.clock ? { clock: seams.clock } : {}),
  });
  try {
    return await evaluate(options, config, dry, labels, seams);
  } finally {
    await dry.close();
  }
}

async function evaluate(options: EvalOptions, config: Config, dry: ReturnType<typeof dryContext>, labels: Labels | null, seams: EvalSeams): Promise<EvalReport> {
  const { ctx, google } = dry;
  const tz = ctx.timeZone;
  const jobs = new Set(options.jobs);
  const aliases = ctx.googleConfig.accounts.map((each) => each.alias);
  const owner = ownerAddresses(ctx.db, ctx.googleConfig);
  const failures: string[] = [];

  const states = new Map<EvalJob, JobState>(options.jobs.map((job) => [job, { ok: true }]));
  // guard runs one step of a job. an error stops that job with its text, so one job never stops the report.
  const guard = (job: EvalJob, step: () => void) => {
    if (!states.get(job)?.ok) return;
    try {
      step();
    } catch (err) {
      states.set(job, { ok: false, error: short(err) });
    }
  };

  const mails = new Map<string, MailFact>();
  // the keys of every mail that the digest read, also when classifyMail fails.
  const digestKeys = new Set<string>();
  let mailCount = 0;
  const dates = { mails: 0, mentions: 0, withDates: 0 };
  const receipts: ReceiptFact[] = [];
  const receiptById = new Map<string, ReceiptFact>();
  const senders = new Map<string, SenderGroup>();
  let listMail = 0;
  const accounts: AccountCoverage[] = [];
  const oldest = ctx.clock().getTime() - RECEIPT_DAYS * DAY_MS;

  for (const alias of aliases) {
    const cover: AccountCoverage = {
      alias,
      read: true,
      error: null,
      digest: { listed: 0, limit: DIGEST_MAX, capped: false },
      subscriptions: { listed: 0, limit: RECEIPT_MAX, capped: false },
      newsletters: { listed: 0, limit: SWEEP_MAX, capped: false },
      htmlOnly: null,
    };
    let contacts = new Set<string>();
    accounts.push(cover);
    const why = google.accounts.unavailable(alias);
    if (why) {
      cover.read = false;
      cover.error = scrub(why).slice(0, 200);
      continue;
    }
    let full = 0;
    let htmlOnly = 0;
    const tally = (messages: gmail_v1.Schema$Message[]) => {
      full += messages.length;
      htmlOnly += messages.filter((each) => !hasPlain(each.payload)).length;
    };
    // each job reads in a run of its own, so a failure of one job keeps the counts of the others.
    const read = async (job: string, work: (apis: GoogleApis) => Promise<void>) => {
      try {
        await google.accounts.run(alias, work);
      } catch (err) {
        cover.read = false;
        cover.error ??= `${job}: ${readError(err)}`;
      }
    };
    if (jobs.has('digest') || jobs.has('deadlines')) {
      await read('digest', async (apis) => {
        // one more id than the limit tells whether the account has more mail than the job reads.
        // the people the owner wrote to are persons for the plain view of the kinds. the sent mail is read for its To
        // and Cc headers only.
        if (jobs.has('digest')) {
          const sent = await listMessages(apis, SENT_QUERY, SENT_MAX);
          contacts = contactsOf(await getMessages(apis, sent.map((each) => each.id), { format: 'metadata', headers: ['To', 'Cc'] }));
        }
        const refs = await listMessages(apis, DIGEST_QUERY, DIGEST_MAX + 1);
        cover.digest = coverage(refs.length, DIGEST_MAX);
        const messages = await getMessages(apis, refs.slice(0, DIGEST_MAX).map((each) => each.id), { format: 'full' });
        tally(messages);
        mailCount += messages.length;
        for (const message of messages) {
          const id = message.id ?? '';
          digestKeys.add(labelKey(alias, id));
          if (jobs.has('digest')) guard('digest', () => mails.set(labelKey(alias, id), { kind: classifyMail(message, owner).kind, check: independentKindOf(message, contacts, owner) }));
          if (jobs.has('deadlines')) {
            guard('deadlines', () => {
              const text = `${header(message, 'Subject')}\n${headOf(bodyText(message.payload), DIGEST_BODY)}`;
              const found = findDates(text, receivedAt(message), tz).length;
              dates.mails++;
              dates.mentions += found;
              if (found) dates.withDates++;
            });
          }
        }
      });
    }
    if (jobs.has('subscriptions')) {
      await read('subscriptions', async (apis) => {
        const refs = await listMessages(apis, RECEIPT_QUERY, RECEIPT_MAX + 1);
        cover.subscriptions = coverage(refs.length, RECEIPT_MAX);
        const messages = (await getMessages(apis, refs.slice(0, RECEIPT_MAX).map((each) => each.id), { format: 'full' })).filter((each) => each.id && Date.parse(receivedAt(each)) >= oldest);
        tally(messages);
        for (const message of messages) guard('subscriptions', () => receiptOf(alias, message));
      });
    }
    if (jobs.has('newsletters')) {
      await read('newsletters', async (apis) => {
        const refs = await listMessages(apis, SWEEP_QUERY, SWEEP_MAX + 1);
        cover.newsletters = coverage(refs.length, SWEEP_MAX);
        const messages = await getMessages(apis, refs.slice(0, SWEEP_MAX).map((each) => each.id), { format: 'metadata', headers: SWEEP_HEADERS });
        for (const message of messages) guard('newsletters', () => senderOf(alias, message));
      });
    }
    cover.htmlOnly = rate(htmlOnly, full);
  }

  function receiptOf(alias: string, message: gmail_v1.Schema$Message): void {
    const subject = cleanLine(header(message, 'Subject'));
    const from = cleanLine(header(message, 'From'));
    const text = bodyText(message.payload);
    const kind = receiptKindOf(subject, text);
    const mentions = amountsIn(text);
    const total = mentions.find((each) => each.total) ?? mentions[0];
    const fact: ReceiptFact = {
      account: alias,
      id: message.id!,
      at: receivedAt(message),
      kind,
      // the check makes no model call here, so the display name of the sender stands in for the name of the model.
      merchant: kind === 'charge' ? merchantOf({ model: displayName(from), from, subject }) : null,
      amounts: mentions.map((each) => ({ amount: each.amount, currency: each.currency })),
      pick: total ? { amount: total.amount, currency: total.currency } : null,
      stated: statedCadenceOf(text),
    };
    receipts.push(fact);
    receiptById.set(labelKey(alias, fact.id), fact);
  }

  function senderOf(alias: string, message: gmail_v1.Schema$Message): void {
    const identity = senderIdentityOf(message);
    if (!identity || !message.id) return;
    listMail++;
    const key = `${alias}\u0000${identity.senderKey}`;
    const group = senders.get(key) ?? { domains: new Set<string>(), names: new Set<string>(), members: [] };
    group.domains.add(identity.fromDomain);
    if (identity.displayName) group.names.add(identity.displayName.toLowerCase());
    group.members.push({ message, at: receivedAt(message), fromAddress: identity.fromAddress });
    senders.set(key, group);
  }

  // the model runs. each one writes rows of the copy, which the metrics read back by the id of its run.
  const calls: DigestCall[] = [];
  let digestItems: DigestItem[] | null = null;
  let scanRun: string | null = null;
  if (options.models) {
    // the digest gives each batch as it built it, so the check never has to read the inputs back out of the text of
    // the prompt, which a mail could forge.
    ctx.observeDigest = (batch: DigestBatch) => {
      calls.push({ account: batch.account, inputs: new Map(batch.inputs.map((each) => [each.id, { text: each.text, sentAt: each.sentAt }])), items: batch.items });
    };
    if (jobs.has('digest') || jobs.has('deadlines')) {
      const result = await runJob(ctx, 'digest', 'utility', (run) => runDigest(ctx, run));
      if (result.status === 'failed') failures.push(`digest: the model run failed: ${short(result.error ?? 'unknown error')}`);
      const row = result.runId ? ctx.db.prepare('SELECT items FROM inbox_digests WHERE runId = ?').get(result.runId) : undefined;
      digestItems = row ? (JSON.parse(String(row.items)) as DigestItem[]) : [];
    }
    if (jobs.has('subscriptions')) {
      // the scan reads only the receipts that no scan read yet, so the copy forgets them and the scan reads every
      // receipt with the code of this commit.
      for (const alias of aliases) ctx.db.prepare('DELETE FROM inbox_receipts WHERE account = ?').run(alias);
      const result = await runJob(ctx, 'subscriptions', 'batch', (run) => scanSubscriptions(ctx, run));
      if (result.status === 'failed') failures.push(`subscriptions: the model run failed: ${short(result.error ?? 'unknown error')}`);
      scanRun = result.runId ?? null;
    }
  }

  const metric = <T>(job: EvalJob, build: () => T): T | null => {
    if (!jobs.has(job)) return null;
    let value = null as T | null;
    guard(job, () => {
      value = build();
    });
    const state = states.get(job)!;
    if (!state.ok) {
      failures.push(`${job}: the check failed: ${state.error}`);
      return null;
    }
    return value;
  };

  const digest = metric('digest', () => digestMetrics(mails, mailCount, digestItems, labels));
  const subscriptions = metric('subscriptions', () => subscriptionMetrics(ctx.db, receipts, receiptById, scanRun, labels, options.names === true, aliases));
  const newsletters = metric('newsletters', () => newsletterMetrics(senders, listMail));
  const deadlines = metric('deadlines', () => deadlineMetrics(dates, calls, digestItems, digestKeys, labels, tz, options.models));
  // without labels the recall and the precision of needs_reply are not measured, so a run with models says that its
  // pass is no pass of the quality.
  if (digest?.models && !labels) failures.push('digest: needs-reply recall and precision were not measured, because no labels file was given, so this run is no quality pass.');

  for (const each of accounts) if (!each.read) failures.push(`${each.alias}: the account could not be read`);

  const refusedGoogle = google.refused.map((each) => (each.startsWith('oneClick ') ? 'oneClick' : scrub(each)));
  const refusedTools = [...dry.refusedTools];
  const base: Omit<EvalReport, 'failures'> = {
    at: ctx.clock().toISOString(),
    commit: seams.commit !== undefined ? seams.commit : commitOf(),
    models: Object.fromEntries(SLOTS.map((slot) => [slot, [...config.slots[slot].chain]])),
    accounts,
    digest,
    subscriptions,
    newsletters,
    deadlines,
    refused: [...refusedGoogle, ...refusedTools.map((name) => `tool ${name}`)],
    refusedGoogle,
    refusedTools,
  };
  return { ...base, failures: [...failures, ...failuresOf(base)] };
}

function digestMetrics(mails: Map<string, MailFact>, messages: number, items: DigestItem[] | null, labels: Labels | null): DigestMetrics {
  const counts = { person: 0, list: 0, automated: 0 };
  for (const each of mails.values()) counts[each.kind]++;
  const list = items ?? [];
  // the plain view of independent.ts decides the bars, so a fault of classifyMail cannot hide itself.
  const checkOf = (item: DigestItem): MailKind | null => mails.get(labelKey(item.account, item.messageId))?.check ?? null;
  let checked = 0;
  let disagreements = 0;
  for (const each of mails.values()) {
    if (each.check === null) continue;
    checked++;
    if ((each.check === 'person') !== (each.kind === 'person')) disagreements++;
  }
  const replies = list.filter((each) => each.section === 'needs_reply');
  const lastReply = list.map((each) => each.section).lastIndexOf('needs_reply');
  const firstOther = list.findIndex((each) => each.section !== 'needs_reply');
  const shownSections = new Set(['deadlines', 'bills', 'packages']);

  let labelled = 0;
  let kindBase = 0;
  let kindHits = 0;
  let recallBase = 0;
  let recallHits = 0;
  let precisionBase = 0;
  let precisionHits = 0;
  if (labels) {
    const replyKeys = new Set(replies.map((each) => labelKey(each.account, each.messageId)));
    for (const [key, fact] of mails) {
      const label = labels.messages[key];
      if (!label) continue;
      labelled++;
      if (label.kind) {
        kindBase++;
        if (label.kind === fact.kind) kindHits++;
      }
      if (items && label.needsReply === true) {
        recallBase++;
        if (replyKeys.has(key)) recallHits++;
      }
    }
    for (const key of replyKeys) {
      const label = labels.messages[key];
      if (label?.needsReply === undefined) continue;
      precisionBase++;
      if (label.needsReply) precisionHits++;
    }
  }
  return {
    models: items !== null,
    messages,
    ...counts,
    items: list.length,
    needsReply: replies.length,
    automatedInNeedsReply: replies.filter((each) => checkOf(each) === 'automated').length,
    needsReplyFirst: lastReply < 0 || firstOther < 0 || lastReply < firstOther,
    automatedShown: list.filter((each) => checkOf(each) === 'automated' && !shownSections.has(each.section)).length,
    checked,
    disagreements,
    labels: labels !== null,
    needsReplyRecall: items && labels ? rate(recallHits, recallBase) : null,
    needsReplyPrecision: items && labels ? rate(precisionHits, precisionBase) : null,
    kindAccuracy: labels ? rate(kindHits, kindBase) : null,
    labelled,
  };
}

interface SubscriptionRow {
  account: string;
  merchantKey: string;
  merchant: string;
  amount: number | null;
  currency: string | null;
  cadence: SubscriptionCadence;
  confidence: number;
  sourceMessageIds: string;
}

function subscriptionMetrics(
  db: Db,
  receipts: ReceiptFact[],
  byId: Map<string, ReceiptFact>,
  scanRun: string | null,
  labels: Labels | null,
  names: boolean,
  aliases: readonly string[],
): SubscriptionMetrics {
  const kinds: SubscriptionMetrics['kinds'] = { charge: 0, refund: 0, order: 0, other: 0 };
  for (const each of receipts) kinds[each.kind]++;
  const charges = receipts.filter((each) => each.kind === 'charge');

  // the subscriptions with the facts of their receipts: the rows of the scan with models, else the groups of the code.
  const found: Array<{ account: string; key: string; merchant: string; amount: number | null; currency: string | null; cadence: SubscriptionCadence; confidence: number; facts: ReceiptFact[] }> = [];
  let amountInText: Rate = null;
  if (scanRun) {
    const rows = db.prepare('SELECT account, messageId, amount, currency FROM inbox_receipts WHERE runId = ? AND amount IS NOT NULL').all(scanRun) as Array<{
      account: string;
      messageId: string;
      amount: number;
      currency: string | null;
    }>;
    let base = 0;
    let hits = 0;
    for (const row of rows) {
      const fact = byId.get(labelKey(row.account, row.messageId));
      if (!fact) continue;
      base++;
      if (fact.amounts.some((each) => sameAmount(each.amount, row.amount) && (!row.currency || each.currency === row.currency))) hits++;
    }
    amountInText = rate(hits, base);
    const subscriptions = db
      .prepare('SELECT account, merchantKey, merchant, amount, currency, cadence, confidence, sourceMessageIds FROM inbox_subscriptions WHERE runId = ? ORDER BY account, merchantKey')
      .all(scanRun) as unknown as SubscriptionRow[];
    for (const row of subscriptions) {
      if (!aliases.includes(row.account)) continue;
      let ids: unknown = [];
      try {
        ids = JSON.parse(row.sourceMessageIds);
      } catch {
        ids = [];
      }
      const facts = (Array.isArray(ids) ? ids : []).flatMap((id) => byId.get(labelKey(row.account, String(id))) ?? []);
      found.push({ account: row.account, key: row.merchantKey, merchant: row.merchant, amount: row.amount, currency: row.currency, cadence: row.cadence, confidence: row.confidence, facts });
    }
  } else {
    const groups = new Map<string, ReceiptFact[]>();
    for (const each of charges) {
      if (!each.merchant?.key) continue;
      const key = labelKey(each.account, each.merchant.key);
      groups.set(key, [...(groups.get(key) ?? []), each]);
    }
    for (const group of groups.values()) {
      const facts: ChargeFact[] = group.map((each) => ({
        chargedAt: each.at,
        amount: each.pick?.amount ?? null,
        currency: each.pick?.currency ?? null,
        statedCadence: each.stated,
        recurring: each.stated !== null,
        amountInText: each.pick !== null,
      }));
      const judgement = judgeSubscription(facts);
      if (!judgement.subscription) continue;
      const newest = [...group].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]!;
      found.push({
        account: newest.account,
        key: newest.merchant!.key,
        merchant: newest.merchant!.merchant,
        amount: newest.pick?.amount ?? null,
        currency: newest.pick?.currency ?? null,
        cadence: judgement.cadence,
        confidence: judgement.confidence,
        facts: group,
      });
    }
  }

  const confidence = { low: 0, middle: 0, high: 0 };
  let cadenceConflicts = 0;
  let mixedDomains = 0;
  for (const each of found) {
    if (each.confidence < 0.5) confidence.low++;
    else if (each.confidence < 0.8) confidence.middle++;
    else confidence.high++;
    const stated = new Set(each.facts.flatMap((fact) => (fact.stated ? [fact.stated] : [])));
    const gaps = cadenceOf(each.facts.map((fact) => fact.at)).cadence;
    const known = each.cadence !== 'unknown' ? each.cadence : gaps;
    if (stated.size > 1 || (stated.size === 1 && known !== 'unknown' && !stated.has(known as StatedCadence))) cadenceConflicts++;
    const domains = new Set(each.facts.flatMap((fact) => (fact.merchant?.domain ? [fact.merchant.domain] : [])));
    if (domains.size > 1) mixedDomains++;
  }

  let merchantAccuracy: Rate = null;
  let amountAccuracy: Rate = null;
  let cadenceAccuracy: Rate = null;
  if (labels) {
    const byKey = new Map(found.map((each) => [labelKey(each.account, each.key), each]));
    const entries = Object.entries(labels.subscriptions).filter(([key]) => aliases.includes(key.slice(0, key.indexOf(':'))));
    let merchant = 0;
    let amount = 0;
    let cadence = 0;
    for (const [key, label] of entries) {
      const row = byKey.get(key);
      if (!row) continue;
      if (row.merchant.trim().toLowerCase() === label.merchant.trim().toLowerCase()) merchant++;
      if (row.amount !== null && sameAmount(row.amount, label.amount) && row.currency === label.currency) amount++;
      if (row.cadence === label.cadence) cadence++;
    }
    merchantAccuracy = rate(merchant, entries.length);
    amountAccuracy = rate(amount, entries.length);
    cadenceAccuracy = rate(cadence, entries.length);
  }

  const merchants: MerchantLine[] | undefined = names
    ? found.map((each) => ({
        account: each.account,
        merchant: cleanLine(each.merchant, 60),
        amount: each.amount,
        currency: each.currency,
        cadence: each.cadence,
        confidence: each.confidence,
      }))
    : undefined;
  return {
    models: scanRun !== null,
    receipts: receipts.length,
    kinds,
    subscriptions: found.length,
    amountInText,
    amountFound: rate(charges.filter((each) => each.pick !== null).length, charges.length),
    cadenceConflicts,
    unknownCadence: found.filter((each) => each.cadence === 'unknown').length,
    mixedDomains,
    confidence,
    merchantAccuracy,
    amountAccuracy,
    cadenceAccuracy,
    ...(merchants ? { merchants } : {}),
  };
}

function newsletterMetrics(senders: Map<string, SenderGroup>, messages: number): NewsletterMetrics {
  const methods: NewsletterMetrics['methods'] = { one_click: 0, https: 0, mailto: 0, none: 0 };
  let mixedDomains = 0;
  let mixedNames = 0;
  let linkNotInHeader = 0;
  let unsigned = 0;
  for (const group of senders.values()) {
    if (group.domains.size > 1) mixedDomains++;
    if (group.names.size > 1) mixedNames++;
    // the sweep takes the link of the newest message whose link the sender signed, else the newest link.
    const newestFirst = [...group.members].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const signedBy = (each: (typeof newestFirst)[number]) => {
      const { method } = unsubscribeChoiceOf(each.message);
      return (method === 'one_click' || method === 'https') && verifyUnsubscribeHeaders(each.message, each.fromAddress, SIGNED[method]) === undefined;
    };
    const chosen = newestFirst.find(signedBy) ?? newestFirst.find((each) => header(each.message, 'List-Unsubscribe'));
    if (!chosen) {
      methods.none++;
      continue;
    }
    const choice = unsubscribeChoiceOf(chosen.message);
    methods[choice.method]++;
    if (choice.url !== null && !unsubscribeTargets(header(chosen.message, 'List-Unsubscribe')).includes(choice.url)) linkNotInHeader++;
    if ((choice.method === 'one_click' || choice.method === 'https') && !signedBy(chosen)) unsigned++;
  }
  return { messages, senders: senders.size, mixedDomains, mixedNames, methods, linkNotInHeader, unsigned };
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

function deadlineMetrics(
  dates: { mails: number; mentions: number; withDates: number },
  calls: DigestCall[],
  items: DigestItem[] | null,
  digestKeys: ReadonlySet<string>,
  labels: Labels | null,
  tz: string,
  models: boolean,
): DeadlineMetrics {
  let given = 0;
  let kept = 0;
  let unsupported = 0;
  let beforeMail = 0;
  const dropped: Record<string, number> = {};
  for (const call of calls) {
    for (const raw of call.items) {
      const item = raw as { id?: unknown; dueAt?: unknown; dueText?: unknown } | null;
      if (!item || typeof item.dueAt !== 'string' || !item.dueAt.trim()) continue;
      const input = typeof item.id === 'number' ? call.inputs.get(item.id) : undefined;
      if (input === undefined) continue;
      given++;
      const { text, sentAt } = input;
      const dueText = typeof item.dueText === 'string' ? item.dueText : null;
      const checked = checkDue({ dueAt: item.dueAt, dueText, text, sentAt, timeZone: tz });
      if (!checked.ok) {
        dropped[checked.why] = (dropped[checked.why] ?? 0) + 1;
        continue;
      }
      kept++;
      // the check of the check, without the parser of deadlines.ts: the words of a kept date must be in the mail, and a
      // plain search of the forms of its day must find the day in them.
      const words = checked.due.dueText;
      const day = localDay(new Date(checked.due.at), tz);
      const stated = words !== null && normalized(text).includes(normalized(words)) && statesDay(words, day, sentAt, tz);
      if (!stated) unsupported++;
      const sent = Date.parse(sentAt);
      if (Number.isFinite(sent)) {
        const early = checked.due.allDay ? day < localDay(new Date(sent), tz) : Date.parse(checked.due.at) < sent;
        if (early) beforeMail++;
      }
    }
  }

  let dueAccuracy: Rate = null;
  if (labels && items) {
    const days = new Map<string, Set<string>>();
    for (const each of items) {
      if (!each.dueAt) continue;
      const key = labelKey(each.account, each.messageId);
      days.set(key, (days.get(key) ?? new Set()).add(localDay(new Date(each.dueAt), tz)));
    }
    let base = 0;
    let hits = 0;
    for (const key of digestKeys) {
      const label = labels.messages[key];
      if (!label || label.due === undefined) continue;
      base++;
      const found = days.get(key) ?? new Set<string>();
      if (label.due === null ? found.size === 0 : found.has(label.due)) hits++;
    }
    dueAccuracy = rate(hits, base);
  }
  return {
    models,
    mails: dates.mails,
    mentions: dates.mentions,
    mailsWithDates: dates.withDates,
    given,
    kept,
    dropped,
    unsupported,
    beforeMail,
    dueAccuracy,
  };
}
