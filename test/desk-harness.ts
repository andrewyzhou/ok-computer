import { appendEvent } from '../src/events/log.js';
import { createApprovalFlow, type ApprovalFlow } from '../src/approvals/flow.js';
import type { Delegation, DelegationLinkInput } from '../src/dashboard/desk-types.js';
import type { DeskContext } from '../src/desk/context.js';
import { createDesk, type Desk } from '../src/desk/desk.js';
import { FOLLOW_UP_TASK, runFollowUps, type FollowUpOptions, type FollowUpResult } from '../src/desk/followups.js';
import { NUDGE_TOOL } from '../src/desk/names.js';
import { createDelegation, getDelegation, listDelegationEvents, markChecked, type NewDelegation } from '../src/desk/store.js';
import { fakeResponse, toolStep, type FakeStep } from '../src/models/fake.js';
import { createSlotRunner } from '../src/models/slots.js';
import { ModelError, type ModelCall, type ModelClient } from '../src/models/types.js';
import { createLogger, silentLogger, type Logger } from '../src/observability/logger.js';
import { BUILTIN_RULES, type ReviewRequest, type ReviewResult } from '../src/policy/policy.js';
import { createRunQueue } from '../src/sessions/queue.js';
import { createToolCaller, type ToolCaller } from '../src/tools/caller.js';
import type { ToolOutput } from '../src/tools/registry.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type { FakeMessage } from './fake-google.js';
import { createGoogleHarness, type GoogleHarness } from './google-harness.js';

// the desk against the fake google, a scripted model, the real tool caller and a reviewer stub. a test of the
// follow-up job or the nudge tool drives them through this, so each nudge has a policy decision and a review, as in
// the app. the owner's chat is recorded, not real.

export const TZ = 'America/Los_Angeles';
export const H = 3_600_000;
export const D = 24 * H;
export const deskLink = (id: number) => `http://127.0.0.1:8787/#/desk?id=${id}`;

export interface DeskHarness {
  google: GoogleHarness;
  desk: Desk;
  ctx: DeskContext;
  caller: ToolCaller;
  approvals: ApprovalFlow;
  // the model steps that the slots answer with, in order.
  script: FakeStep[];
  modelCalls: ModelCall[];
  // the texts to the owner.
  sent: string[];
  // the reviewer requests of write calls in a tainted session.
  reviews: ReviewRequest[];
  // the lines that the logger wrote at warn or error.
  logged: Array<{ level: string; msg: string }>;
  // hold makes the reviewer hold every call, with this reason.
  hold: { reason: string | null };
  now(): Date;
  // set moves the clock to an iso time.
  set(iso: string): void;
  run(options?: FollowUpOptions): Promise<FollowUpResult>;
  // seed makes a delegation through the store, with a thread link when thread is given, and a follow-up time that is
  // due now unless another is given.
  seed(input?: Partial<NewDelegation> & { thread?: { account: string; ref: string }; followUpAt?: string | null; nudges?: number; at?: string }): Delegation;
  get(id: number): Delegation;
  history(id: number): string[];
  // deliver puts a message of a thread in the fake mailbox.
  deliver(alias: string, message: ThreadMessage): void;
  // nudge calls the nudge tool through the caller, in a tainted session of its own.
  nudge(input: Record<string, unknown>): Promise<ToolOutput>;
  rows(sql: string, ...params: Array<string | number>): Array<Record<string, unknown>>;
  drafts(alias: string): Array<{ headers: string; body: string }>;
  // approve resolves an approval as the owner on the dashboard, and waits for the tool that it runs.
  approve(id: number): Promise<string>;
  deny(id: number): Promise<string>;
  close(): Promise<void>;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  at: string;
  labelIds?: string[];
  body?: string;
  messageId?: string;
}

// the fake keeps the raw message of a draft. its body is base64, as rawMessage writes it.
export function decoded(raw: string): { headers: string; body: string } {
  const [headers, body] = raw.split('\r\n\r\n');
  return { headers: headers!, body: Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

export function threadMessage(message: ThreadMessage): FakeMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? ['INBOX'],
    internalDate: String(Date.parse(message.at)),
    snippet: (message.body ?? '').slice(0, 50),
    body: message.body ?? 'Thanks, I will look into it.',
    headers: {
      From: message.from,
      To: message.to ?? 'personal@example.com',
      ...(message.cc ? { Cc: message.cc } : {}),
      Subject: message.subject ?? 'Lease renewal',
      Date: new Date(message.at).toUTCString(),
      'Message-ID': message.messageId ?? `<${message.id}@mail.example>`,
    },
  };
}

// the step that writeNudge answers with.
export const nudgeStep = (body: string): FakeStep => toolStep({ id: 'n1', name: 'write_nudge', input: { items: [{ id: 1, body }] } });

export async function createDeskHarness(options: { accounts?: string[]; google?: boolean; review?: (request: ReviewRequest) => Promise<ReviewResult> } = {}): Promise<DeskHarness> {
  const google = await createGoogleHarness({ accounts: options.accounts ?? ['personal', 'school'], config: { send: false } });
  for (const alias of google.config.accounts.map((each) => each.alias)) google.signedIn(alias);
  const { db } = google;
  const clock = () => google.now.value;
  const script: FakeStep[] = [];
  const modelCalls: ModelCall[] = [];
  const client: ModelClient = {
    provider: 'fake',
    async complete(call, signal, onText) {
      modelCalls.push(structuredClone(call));
      const step = script.shift();
      // a missing step is a model that gives no tool call, so writeNudge takes its fixed text.
      if (!step) return fakeResponse({ text: '', model: call.model });
      if (step instanceof ModelError) throw step;
      if (typeof step === 'function') return step(call, signal, onText);
      return fakeResponse({ ...step, model: step.model ?? call.model });
    },
  };
  const slot = { chain: ['fake/m'], maxTokens: 4000 };
  const slots = createSlotRunner({
    db,
    config: { slots: { main: slot, utility: slot, batch: slot, heartbeat: slot, consolidation: slot, compaction: slot }, pricing: {} } as never,
    clients: { fake: client },
    logger: silentLogger,
    clock,
    sleep: async () => {},
  });
  const sent: string[] = [];
  const owner = {
    remember() {},
    chat: () => ({ channel: 'cli', chatId: 'local' }),
    async send(text: string) {
      sent.push(text);
      return true;
    },
  };
  const logged: DeskHarness['logged'] = [];
  const base = createLogger({ consoleLevel: 'off' });
  const logger: Logger = {
    ...base,
    warn: (msg, fields) => (logged.push({ level: 'warn', msg }), base.warn(msg, fields)),
    error: (msg, fields) => (logged.push({ level: 'error', msg }), base.error(msg, fields)),
  };
  const queue = createRunQueue();
  const signal = new AbortController().signal;
  const reviews: ReviewRequest[] = [];
  const hold: DeskHarness['hold'] = { reason: null };
  let ids = 0;
  let caller: ToolCaller | undefined;
  const approvals = createApprovalFlow({ db, clock, logger: silentLogger, queue, owner, caller: () => caller!, signal, timeoutMs: 60_000, timeZone: TZ });
  const newId = () => `id-${++ids}`;
  const activeRuns = new Set<string>();
  const withGoogle = options.google !== false;
  const desk = createDesk({
    db,
    clock,
    logger,
    timeZone: TZ,
    ...(withGoogle ? { google: { accounts: google.accounts }, googleConfig: google.config } : {}),
    slots,
    caller: () => caller!,
    owner,
    deskLink,
    signal,
    activeRuns,
    newId,
  });
  const ctx: DeskContext = {
    db,
    clock,
    logger,
    timeZone: TZ,
    ...(withGoogle ? { google: { accounts: google.accounts }, googleConfig: google.config } : {}),
    slots,
    caller: () => caller!,
    owner,
    deskLink,
    signal,
    activeRuns,
    newId,
  };
  caller = createToolCaller({
    db,
    blobs: google.blobs,
    tools: createToolRegistry(desk.tools, silentLogger),
    rules: BUILTIN_RULES,
    reviewer: async (request) => {
      reviews.push(request);
      if (hold.reason) return { verdict: 'hold', reason: hold.reason };
      return options.review ? options.review(request) : { verdict: 'allow', reason: 'the test reviewer allows it' };
    },
    requestApproval: approvals.request,
    queue,
    logger: silentLogger,
    clock,
    timeZone: TZ,
  });

  let nudgeRuns = 0;
  const harness: DeskHarness = {
    google,
    desk,
    ctx,
    caller,
    approvals,
    script,
    modelCalls,
    sent,
    reviews,
    logged,
    hold,
    now: clock,
    set(iso) {
      google.now.value = new Date(iso);
    },
    run: (runOptions) => runFollowUps(ctx, runOptions),
    seed(input = {}) {
      const { thread, followUpAt, nudges, at, ...rest } = input;
      const links: DelegationLinkInput[] = [...(rest.links ?? []), ...(thread ? [{ kind: 'thread' as const, ref: thread.ref, account: thread.account }] : [])];
      const when = at ? new Date(at) : new Date(clock().getTime() - 4 * D);
      const made = createDelegation(
        db,
        {
          title: 'Get the lease renewal from Dana',
          waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' },
          createdBy: 'agent',
          ...rest,
          links,
          nextFollowUpAt: followUpAt === undefined ? new Date(clock().getTime() - H).toISOString() : followUpAt,
        },
        { actor: 'agent', runId: 'run-seed' },
        when,
      );
      if (!made.ok) throw new Error(made.error);
      if (nudges) {
        db.prepare('UPDATE delegations SET nudges = ? WHERE id = ?').run(nudges, made.value.id);
      }
      return getDelegation(db, made.value.id)!;
    },
    get: (id) => getDelegation(db, id)!,
    history: (id) => listDelegationEvents(db, id).map((each) => each.kind),
    deliver(alias, message) {
      google.fake.deliver(alias, threadMessage(message));
    },
    async nudge(input) {
      // a session of its own that read the mail of both accounts, as the follow-up run does.
      const runId = `nudge-run-${++nudgeRuns}`;
      const sessionKey = `desk:followups:${runId}`;
      db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'automation', 'utility', 'running', ?)").run(runId, sessionKey, clock().toISOString());
      const at = clock().toISOString();
      const taint = google.config.accounts.map((each) => ({ source: `gmail:${each.alias}`, toolName: 'desk_followups', runId, toolCallId: `followups-${runId}`, at }));
      appendEvent(db, { sessionKey, runId, type: 'system_event', payload: { text: FOLLOW_UP_TASK } }, clock());
      appendEvent(db, { sessionKey, runId, type: 'system_event', payload: { text: 'The desk follow-ups read the mail.', taint } }, clock());
      return caller!.call({ id: `followups-${newId()}`, name: NUDGE_TOOL, input }, { runId, sessionKey, allowed: [NUDGE_TOOL], signal });
    },
    rows: google.rows,
    drafts(alias) {
      return [...google.fake.mailbox(alias).drafts.values()].map((draft) => decoded(draft.message.body!));
    },
    async approve(id) {
      const text = await approvals.resolve(id, 'approve', 'dashboard');
      await queue.drain();
      return text;
    },
    async deny(id) {
      const text = await approvals.resolve(id, 'deny', 'dashboard');
      await queue.drain();
      return text;
    },
    async close() {
      await queue.drain();
      await google.close();
    },
  };
  return harness;
}

// markDue moves the follow-up time of a delegation to the given time, as a later follow-up does.
export function markDue(h: DeskHarness, id: number, iso: string): void {
  markChecked(h.google.db, id, { nextFollowUpAt: iso }, h.now());
}
