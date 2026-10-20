import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createDelegateTool, PROFILES, profileOf, SUBAGENT_INSTRUCTIONS } from './agent/delegate.js';
import { runAgent, type AgentDeps } from './agent/loop.js';
import { closeStaleWork, interruptedText, repairSession, replyLost } from './agent/recovery.js';
import { buildStablePrompt } from './agent/system-prompt.js';
import { createAlwaysAllow } from './approvals/always.js';
import { approvalNote, createApprovalFlow, type ApprovalFlow } from './approvals/flow.js';
import { expireApprovals, type Approval } from './approvals/store.js';
import type { ChannelAdapter } from './channels/types.js';
import { isWebChannel, WEB, type WebChat } from './channels/web.js';
import type { LoginCodes } from './dashboard/login.js';
import type { Config } from './config/schema.js';
import { sinceLastReset } from './context/full-history.js';
import { createTrimAndCompact } from './context/trim-and-compact.js';
import type { Db } from './db/index.js';
import { appendEvent, listEvents } from './events/log.js';
import { installRoutine } from './goals/routine.js';
import { createGoalTools } from './goals/tools.js';
import {
  CONSOLIDATION_INSTRUCTIONS,
  CONSOLIDATION_PREFIX,
  CONSOLIDATION_TOOLS,
  createConsolidation,
  createConsolidationTools,
  installConsolidation,
} from './memory/consolidate.js';
import { appendToDailyNote, sessionExcerpt } from './memory/daily.js';
import { createMemoryTools } from './memory/tools.js';
import { createGoogle, syncGooglePoll, type Google } from './google/google.js';
import { createInbox, installInboxJobs, type Inbox } from './inbox/inbox.js';
import { createDesk, DESK_INSTRUCTIONS, installDeskJobs } from './desk/index.js';
import type { GoogleEndpoints } from './google/accounts.js';
import { finishDigest, noteFailedDigest, signalDigest, type Digest } from './signals/digest.js';
import { sessionProfile, type IntegrationEntry } from './integrations/config.js';
import { createIntegrations, type Integrations, type IntegrationsDeps } from './integrations/integrations.js';
import { createOAuth } from './integrations/oauth.js';
import { syncPolls } from './integrations/polls.js';
import { createMemorySecretStore, type SecretStore } from './integrations/secrets.js';
import { createSlackDmPoll } from './integrations/slack-dms.js';
import type { SecretVault } from './secrets/index.js';
import { createSlotRunner } from './models/slots.js';
import type { ModelClient, ModelRequest } from './models/types.js';
import { createBlobStore } from './observability/blobs.js';
import type { Logger } from './observability/logger.js';
import { BUILTIN_RULES, type Rule } from './policy/policy.js';
import { guardReply } from './policy/reply.js';
import { createReviewer } from './policy/reviewer.js';
import { createSandbox, type Sandbox, type SandboxOptions } from './sandbox/sandbox.js';
import { scheduleContext } from './scheduler/context.js';
import {
  createHeartbeat,
  createHeartbeatTools,
  HEARTBEAT_INSTRUCTIONS,
  HEARTBEAT_PREFIX,
  HEARTBEAT_TOOLS,
  syncHeartbeat,
} from './scheduler/heartbeat.js';
import { AUTOMATION_TOOLS, createJobRunner } from './scheduler/jobs.js';
import { createScheduler, type Scheduler, type SetTimer } from './scheduler/scheduler.js';
import { createAutomationTools } from './scheduler/tools.js';
import { createCommands, signInLink } from './sessions/commands.js';
import { createOwnerMessenger } from './sessions/owner.js';
import { createRunQueue } from './sessions/queue.js';
import { createRouter, MAIN_SESSION, MAIN_TOOLS } from './sessions/router.js';
import { localDay, localTime, type Clock } from './time.js';
import { createSkillTools } from './skills/skills.js';
import { createSkillWriteTool } from './skills/skill-write.js';
import { createWorkshop, installWorkshop, SKILL_LOST_TEXT, WORKSHOP_INSTRUCTIONS, WORKSHOP_PREFIX, WORKSHOP_TOOLS } from './skills/workshop.js';
import { createToolCaller } from './tools/caller.js';
import { createMessageOwnerTool } from './tools/message-owner.js';
import { nowTool } from './tools/now.js';
import { createToolRegistry } from './tools/registry.js';
import { createResultReadTool } from './tools/result-read.js';
import { createWeb, type WebOptions } from './web/web.js';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  clients: Record<string, ModelClient>;
  channels: ChannelAdapter[];
  // the sender id of the owner on each channel other than the cli, for example the telegram user id.
  ownerIds?: Record<string, string>;
  clock: Clock;
  // the policy rules: the built-in rules, then the rules of okc.policy.json.
  rules?: readonly Rule[];
  setTimer?: SetTimer;
  newId?: () => string;
  // the entries of okc.integrations.json, and the store of their secrets.
  integrations?: IntegrationEntry[];
  secrets?: SecretStore;
  // the store that the secrets block of the config chose, for GET /api/secrets. main.ts makes it, and its store is
  // the secrets above.
  secretVault?: SecretVault;
  // tests connect in-memory servers. the app starts stdio processes and http connections.
  mcpTransport?: IntegrationsDeps['transport'];
  // false in npm run chat. see start(). the browser follows the same switch: one chrome can use its profile.
  connectIntegrations?: boolean;
  // false in npm run chat. only the service runs the scheduler, so a reminder, a check-in or the skill review never
  // goes to the terminal of a chat process.
  background?: boolean;
  // the policy file that "always allow" writes. without it, approval cards have no "always allow" button.
  policyPath?: string;
  // the codes of the dashboard that runs in this process. with them and dashboard.publicUrl, /dashboard sends a
  // sign-in link.
  loginCodes?: LoginCodes;
  // tests point the google integration at a local fake.
  googleEndpoints?: GoogleEndpoints;
  // tests point the web tools at a local fixture site.
  web?: WebOptions;
  // the code sandbox runs only when this is set. main.ts sets it, and a test gives fakes.
  sandbox?: SandboxOptions;
}

export interface App {
  scheduler: Scheduler;
  start(): Promise<void>;
  // idle waits until every queued run has ended.
  idle(): Promise<void>;
  // stop ends the channels, aborts the active runs and waits for them to record their status.
  stop(): Promise<void>;
  // contextView renders the session with the same strategy, prompt and tools as its next model call.
  contextView(sessionKey: string): Promise<ModelRequest>;
  resolveApproval: ApprovalFlow['resolve'];
  // the policy rules that the caller uses now. "always allow" adds to this list while the app runs.
  rules: readonly Rule[];
  integrations: Integrations;
  google?: Google;
  // the web chat of the dashboard. it exists when the web channel is one of the channels.
  chat?: WebChat;
  inbox?: Inbox;
  sandbox: Pick<Sandbox, 'status'>;
  secretVault?: SecretVault;
}

// a run ends at its timeout. the margin covers the end of the run itself, so a live run is never closed as stale.
const STALE_MARGIN_MS = 5 * 60_000;

function sessionTools(sessionKey: string): readonly string[] {
  if (sessionKey === MAIN_SESSION) return MAIN_TOOLS;
  if (sessionKey.startsWith(HEARTBEAT_PREFIX)) return HEARTBEAT_TOOLS;
  if (sessionKey.startsWith(CONSOLIDATION_PREFIX)) return CONSOLIDATION_TOOLS;
  if (sessionKey.startsWith(WORKSHOP_PREFIX)) return WORKSHOP_TOOLS;
  if (sessionKey.startsWith('sub:')) return profileOf(sessionKey)?.tools ?? [];
  return AUTOMATION_TOOLS;
}

// the app wires the modules together. main.ts and the integration tests both use it.
export function createApp(deps: AppDeps): App {
  const { config, db, logger, clock } = deps;
  const shutdown = new AbortController();
  const queue = createRunQueue();
  const memoryDir = join(config.paths.data, 'memory');
  const memoryPath = join(memoryDir, 'MEMORY.md');
  const channels = new Map(deps.channels.map((channel) => [channel.id, channel]));
  const webChannel = deps.channels.find(isWebChannel);
  const ownerIds = deps.ownerIds ?? {};
  // in a private telegram chat, the chat id is the same as the user id of the owner.
  const [preferred] = Object.entries(ownerIds).map(([channel, chatId]) => ({ channel, chatId }));
  const owner = createOwnerMessenger({ db, channels, logger, clock, ...(preferred ? { preferred } : {}) });
  const ids = deps.newId ? { newId: deps.newId } : {};
  const blobs = createBlobStore(db, join(config.paths.data, 'blobs'), clock);
  const entries = deps.integrations ?? [];
  const secrets = deps.secrets ?? createMemorySecretStore();
  const oauth = entries.some((entry) => entry.kind === 'mcp-http' && entry.auth?.type === 'oauth')
    ? createOAuth({ db, clock, logger, secrets })
    : undefined;
  const integrations = createIntegrations({
    db,
    blobs,
    logger,
    clock,
    entries,
    secrets,
    ...(oauth ? { oauth } : {}),
    onNeedsAuth: (id, said) =>
      void owner
        .send(
          `The ${id} integration needs you to sign in again, and its tools do not work until then.${said ? ` The server said: ${said}` : ''} ` +
            `Connect it on the computer that runs the agent: http://127.0.0.1:${config.dashboard.port}/#/integrations/${id}`,
        )
        .catch((err: unknown) => logger.error('needs-auth message failed', { integration: id, err })),
    ...(deps.mcpTransport ? { transport: deps.mcpTransport } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    connects: deps.connectIntegrations !== false,
  });
  // the slot runner comes later. the google classifier calls it only during a poll, after the start.
  const google = config.google
    ? createGoogle({
        db,
        clock,
        logger,
        blobs,
        secrets,
        slots: { call: (...args) => slots.call(...args) },
        config: config.google,
        timeZone: config.timeZone,
        notifyOwner: (text) => owner.send(text),
        polls: deps.connectIntegrations !== false,
        signal: shutdown.signal,
        ...(deps.googleEndpoints ? { endpoints: deps.googleEndpoints } : {}),
        ...ids,
      })
    : undefined;
  // the runs that work in this process. the sweep of stale runs leaves them alone.
  const activeRuns = new Set<string>();
  // the inbox jobs (phase 5 m8) use the google accounts. the slot runner, the caller and the agent come later, and
  // the jobs call them only after the start.
  const inbox = google
    ? createInbox({
        db,
        clock,
        logger,
        blobs,
        timeZone: config.timeZone,
        google,
        googleConfig: config.google!,
        slots: { call: (...args) => slots.call(...args) },
        caller: () => caller,
        owner,
        agent: (input) => agent(input),
        queue,
        signal: shutdown.signal,
        activeRuns,
        ...ids,
      })
    : undefined;
  // the desk of phase 6 t3 needs only the database, so it exists also without google. its follow-up job reads mail
  // threads and saves nudge drafts only when the google accounts are there.
  const dashboardUrl = (deps.loginCodes && config.dashboard.publicUrl) || `http://127.0.0.1:${config.dashboard.port}`;
  const desk = createDesk({
    db,
    clock,
    logger,
    timeZone: config.timeZone,
    ...(google ? { google, googleConfig: config.google! } : {}),
    slots: { call: (...args) => slots.call(...args) },
    caller: () => caller,
    owner,
    deskLink: (id) => `${dashboardUrl}/#/desk?id=${id}`,
    signal: shutdown.signal,
    activeRuns,
    ...ids,
  });
  // /status shows each google account with the mcp integrations, so the owner can see on the phone that a sign-in works.
  const googleStates = () =>
    google
      ? google.accounts.aliases.map((alias) => {
          const row = db.prepare('SELECT status FROM google_accounts WHERE alias = ?').get(alias);
          return { id: `google:${alias}`, state: { status: String(row?.status ?? 'signed_out') } };
        })
      : [];
  const web = createWeb({ db, blobs, logger, clock, config, enabled: deps.connectIntegrations !== false, ...deps.web });
  const sandbox = createSandbox({ db, blobs, logger, clock, config, enabled: deps.sandbox !== undefined, ...(deps.web?.egress ? { egress: deps.web.egress } : {}), ...deps.sandbox });
  // each run gets the integration tools of its session. the list comes from the config, not from a catalog, so the
  // tools parameter of a session never changes when a server changes its tools.
  const withIntegrations = (sessionKey: string, base: readonly string[]) => [
    ...base,
    ...web.toolsFor(sessionKey),
    ...sandbox.toolsFor(sessionKey),
    ...integrations.allowedNames(sessionKey),
    ...(google?.toolNames(sessionProfile(sessionKey)) ?? []),
  ];

  const approvals = createApprovalFlow({
    db,
    clock,
    logger,
    queue,
    owner,
    caller: () => caller,
    signal: shutdown.signal,
    timeoutMs: config.agent.backgroundTimeoutMs,
    timeZone: config.timeZone,
    alwaysAllow: deps.policyPath !== undefined,
  });
  // "always allow" changes this list in place, and the caller reads it at each call.
  const rules = [...(deps.rules ?? BUILTIN_RULES)];
  const always = deps.policyPath
    ? createAlwaysAllow({
        db,
        clock,
        logger,
        timeZone: config.timeZone,
        policyPath: deps.policyPath,
        rules,
        resolve: approvals.resolve,
        // the lookup checks the current config, as an approved call does.
        toolOf: (approval) => {
          const found = tools.resolve({ id: 'always', name: approval.toolName, input: approval.input }, [approval.toolName], approval.sessionKey);
          return found.ok ? found.tool : undefined;
        },
      })
    : undefined;
  // the scheduler is created below. the tools call replan only after the start.
  const replan = () => scheduler.replan();
  const builtIn = [
    nowTool,
    ...createGoalTools({ db, replan }),
    ...createAutomationTools({ db, replan }),
    ...createHeartbeatTools({ db }),
    ...createMemoryTools({ db, memoryDir }),
    ...createConsolidationTools({ db, memoryDir }),
    createMessageOwnerTool(owner),
    ...createSkillTools({ skillsDir: config.paths.skills }),
    createSkillWriteTool({ skillsDir: config.paths.skills }),
    createResultReadTool({ db, blobs }),
    ...web.tools,
    ...sandbox.tools,
  ];
  // a profile names built-in tools and google tools. a name that this app does not have is left out.
  const registered = new Set([...builtIn, ...(google?.tools ?? [])].map((tool) => tool.name));
  const tools = createToolRegistry(
    [
      ...builtIn,
      createDelegateTool({
        db,
        clock,
        queue,
        newId: deps.newId ?? randomUUID,
        toolsOf: (profile) => withIntegrations(`sub:${profile}`, PROFILES[profile].tools.filter((name) => registered.has(name))),
        // the child does not use agent(), because a child that stops reports to its parent, not to the owner.
        runChild: (input) => runAgent(agentDeps, input),
      }),
      ...integrations.tools,
      ...(google?.tools ?? []),
      ...(inbox?.tools ?? []),
      ...desk.tools,
    ],
    logger,
    integrations.find,
    integrations.explain,
  );
  const slots = createSlotRunner({ db, config, clients: deps.clients, logger, clock });
  const reviewer = createReviewer({ db, slots });
  const caller = createToolCaller({
    db,
    blobs,
    tools,
    rules,
    reviewer,
    requestApproval: approvals.request,
    queue,
    logger,
    clock,
    timeZone: config.timeZone,
  });

  const strategy = createTrimAndCompact({ db, slots, logger, clock, windowTokens: config.context.windowTokens });
  const agentDeps: AgentDeps = {
    db,
    slots,
    tools,
    caller,
    strategy,
    logger,
    config,
    clock,
    stablePrompt: (sessionKey) =>
      buildStablePrompt({
        workspaceDir: config.paths.workspace,
        timeZone: config.timeZone,
        ...(sessionKey === MAIN_SESSION ? { memoryPath, ...(DESK_INSTRUCTIONS ? { extraInstructions: DESK_INSTRUCTIONS } : {}) } : {}),
        ...(sessionTools(sessionKey).includes('skill_read') ? { skillsDir: config.paths.skills } : {}),
        // the heartbeat runs often on a small model, so it gets a light prompt.
        ...(sessionKey.startsWith(HEARTBEAT_PREFIX)
          ? { personaFiles: ['USER.md'], extraInstructions: HEARTBEAT_INSTRUCTIONS }
          : {}),
        ...(sessionKey.startsWith(CONSOLIDATION_PREFIX)
          ? { personaFiles: ['USER.md'], extraInstructions: CONSOLIDATION_INSTRUCTIONS }
          : {}),
        ...(sessionKey.startsWith(WORKSHOP_PREFIX) ? { personaFiles: ['USER.md'], extraInstructions: WORKSHOP_INSTRUCTIONS } : {}),
        // a sub-agent needs no persona and no facts about the owner for its task, so it gets none.
        ...(sessionKey.startsWith('sub:') ? { personaFiles: [], extraInstructions: SUBAGENT_INSTRUCTIONS } : {}),
      }),
    contextLines: (now) => scheduleContext(db, now, config.timeZone),
    activeRuns,
    ...ids,
  };
  const agent = async (input: Parameters<typeof runAgent>[1]) => {
    // the router and the automation runner send the final text to the owner's chat, so it goes through the guard.
    const guard = (text: string, run: { runId: string; signal: AbortSignal }) =>
      guardReply({ db, reviewer, logger, clock }, { ...run, sessionKey: input.sessionKey }, text);
    const result = await runAgent(agentDeps, { ...input, allowedTools: withIntegrations(input.sessionKey, input.allowedTools), guardReply: guard });
    // the router tells the owner about a stopped message run in its reply. a background run has no reply, so the owner gets a message here.
    if (result.stoppedAtLimit && input.trigger !== 'message') {
      await owner.send(`The ${input.trigger} run did not finish: ${result.error}.`);
    }
    return result;
  };

  const heartbeat = createHeartbeat({
    db,
    clock,
    logger,
    config,
    queue,
    owner,
    agent,
    signal: shutdown.signal,
    ...ids,
    // the signals are the same for every source that polls. only google rows reach the digest now: a slack row stays
    // new. a process that does not poll (npm run chat) does not take them either: its heartbeat would tell the cli and
    // close them, so they never reach the owner's chat.
    ...(google && deps.connectIntegrations !== false
      ? {
          signals: {
            digest: (now: Date) => signalDigest(db, now, config.timeZone),
            finish: (digest: Digest, runId: string | null, notified: boolean, now: Date) => finishDigest(db, digest, runId, notified, now),
            failed: (digest: Digest) => noteFailedDigest(db, digest),
          },
        }
      : {}),
  });
  // only the process that connects polls. in npm run chat a due poll is skipped, and the service polls at its next turn.
  const slackDms = createSlackDmPoll({ db, blobs, logger, clock, connection: integrations.connection });
  const polls =
    deps.connectIntegrations === false
      ? undefined
      : new Map(entries.filter((entry) => entry.kind === 'mcp-http' && entry.poll === 'slack-dms').map((entry) => [entry.id, () => slackDms(entry.id)]));
  const runJob = createJobRunner({
    db,
    clock,
    logger,
    config,
    queue,
    owner,
    agent,
    heartbeat,
    consolidation: createConsolidation({ db, clock, config, memoryDir, queue, agent, signal: shutdown.signal, ...ids }),
    ...(polls ? { polls } : {}),
    workshop: createWorkshop({ db, clock, config, queue, agent, signal: shutdown.signal, ...ids }),
    ...(google ? { sourcePolls: { google: google.poll } } : {}),
    ...(inbox ? { inboxJobs: (job: Parameters<Inbox['runJob']>[0]) => inbox.runJob(job) } : {}),
    deskJobs: (job) => desk.runJob(job),
    signal: shutdown.signal,
    ...ids,
  });
  // a run or a job that is older than this belongs to a process that stopped.
  const staleMs = Math.max(config.agent.chatTimeoutMs, config.agent.backgroundTimeoutMs) + STALE_MARGIN_MS;
  const scheduler = createScheduler({
    db,
    clock,
    logger,
    config,
    execute: runJob,
    notifyOwner: async (text) => void (await owner.send(text)),
    onTick: (now) => sweep(now),
    staleMs,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  });

  const router = createRouter({
    db,
    logger,
    clock,
    queue,
    channels,
    agent,
    // the cli runs on the owner's own terminal, and the dashboard signed in each web request. other channels check the
    // sender id against the owner id.
    isOwner: (message) => message.channel === 'cli' || message.channel === WEB || ownerIds[message.channel] === message.senderId,
    rememberOwnerChat: owner.remember,
    approvals: approvals.resolve,
    approvalCard: approvals.card,
    ...(always ? { always } : {}),
    commands: createCommands({
      db,
      clock,
      timeZone: config.timeZone,
      // the dashboard accepts the public name only with a token, and the sign-in codes exist only then. without them,
      // a link to the public name gets a 403.
      dashboardUrl: (deps.loginCodes && config.dashboard.publicUrl) || `http://127.0.0.1:${config.dashboard.port}`,
      ...(config.dashboard.publicUrl && deps.loginCodes ? { signInLink: signInLink(config.dashboard.publicUrl, deps.loginCodes, config.dashboard.port) } : {}),
      approvalCard: approvals.card,
      integrations: () => [...integrations.status(), ...googleStates()],
    }),
    onReset: () => {
      const now = clock();
      const excerpt = sessionExcerpt(sinceLastReset(listEvents(db, MAIN_SESSION)), localTime(now, config.timeZone));
      if (excerpt) appendToDailyNote(memoryDir, localDay(now, config.timeZone), 'notes', excerpt);
    },
    signal: shutdown.signal,
    ...(webChannel ? { turns: webChannel.turns } : {}),
    ...ids,
  });

  // the sweep closes the work of a stopped process and tells the sessions and the owner. it runs at the start and on
  // each scheduler tick. events go through the session queue, so they never land inside an active run.
  // the note to the session carries the taint of the decision, because the summary is text that the model wrote. the
  // owner gets the same words with the plain summary.
  const tell = (approval: Approval, words: (summary: string) => string, toOwner: boolean) => {
    const { sessionKey } = approval;
    const { text, taint } = approvalNote(db, approval, words);
    void queue
      .enqueue(sessionKey, async () =>
        void appendEvent(db, { sessionKey, runId: null, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } }, clock()),
      )
      .catch((err: unknown) => logger.error('sweep note failed', { sessionKey, err }));
    if (toOwner) void owner.send(words(approval.summary));
  };
  function sweep(now: Date) {
    try {
      for (const approval of expireApprovals(db, now)) {
        tell(approval, (summary) => `Approval #${approval.id} (${summary}) expired after 24 hours without an answer. The tool did not run.`, false);
      }
      const stale = closeStaleWork(db, now, staleMs, { runs: activeRuns, approvals: approvals.active });
      if (stale.runs.length) logger.warn('closed the runs of a stopped process', { runs: stale.runs.map((run) => run.id) });
      // the owner waits for the reply of such a run. the message has no link, because the reply was not checked.
      for (const run of stale.runs.filter((each) => replyLost(db, each.id, false))) {
        void owner.send(`The app stopped while the reviewer checked a reply (run ${run.id.slice(0, 8)}), so the reply did not come to the chat. The run page on the dashboard shows it.`);
      }
      // the next run of a session repairs its calls. an isolated automation and the heartbeat have a session for
      // each run, so no next run comes, and the sweep repairs it. that session belongs to the stale run alone, so no
      // live turn of another process can be in it. a shared session can have such a turn, so the sweep leaves it.
      for (const run of stale.runs.filter((each) => each.sessionKey.endsWith(`:${each.id}`))) {
        void queue
          .enqueue(run.sessionKey, async () => void repairSession(db, run.sessionKey, clock, logger))
          .catch((err: unknown) => logger.error('repair of a stale session failed', { sessionKey: run.sessionKey, err }));
      }
      for (const approval of stale.expired) {
        const words = (summary: string) =>
          `Approval #${approval.id} (${summary}) was approved, but the app stopped before it ran, so it expired and did not run. ${approval.toolName === 'skill_write' ? SKILL_LOST_TEXT : 'Ask again if you still want it.'}`;
        tell(approval, words, true);
      }
      for (const approval of stale.interrupted) {
        tell(approval, (summary) => `Approval #${approval.id} (${summary}) started, but the app stopped while it ran. ${interruptedText(approval.toolName)}`, true);
      }
    } catch (err) {
      logger.error('sweep failed', { err });
    }
  }

  return {
    scheduler,
    async start() {
      sweep(clock());
      web.start();
      // the probe of docker has its own time limit, so a docker that does not answer holds the start for a few seconds
      // at most. the tool list of each session is fixed after it.
      await sandbox.start();
      for (const channel of channels.values()) {
        // node stops the process on an unhandled rejection. a failed write in the reply to one message must not stop
        // the service.
        await channel.start(
          (message) =>
            void router.handle(message).catch((err: unknown) => logger.error('message handling failed', { channel: message.channel, err })),
        );
        logger.info('channel started', { channel: channel.id });
      }
      if (installRoutine(db, config, clock())) logger.info('goals routine installed');
      if (installConsolidation(db, config, clock())) logger.info('memory consolidation installed');
      if (installWorkshop(db, config, clock())) logger.info('skill workshop installed');
      syncHeartbeat(db, config, clock());
      syncPolls(db, entries, clock(), config.timeZone);
      syncGooglePoll(db, config, clock());
      if (inbox && installInboxJobs(db, config, clock())) logger.info('inbox jobs installed');
      if (installDeskJobs(db, config, clock())) logger.info('desk jobs installed');
      // missed jobs can take minutes, so the start does not wait for them.
      if (deps.background !== false) void scheduler.start().catch((err: unknown) => logger.error('scheduler start failed', { err }));
      // a server can need many seconds to start, so the start does not wait. tool_search reads the stored catalog.
      // a second process (npm run chat) keeps the same tools and catalogs but does not connect.
      void integrations.start().catch((err: unknown) => logger.error('integrations start failed', { err }));
    },
    idle: () => queue.drain(),
    async stop() {
      scheduler.stop();
      for (const channel of channels.values()) await channel.stop();
      shutdown.abort();
      await queue.drain();
      await integrations.stop();
      await oauth?.close();
      await google?.close();
      await web.stop();
      await sandbox.stop();
    },
    integrations,
    ...(google ? { google } : {}),
    ...(inbox ? { inbox } : {}),
    sandbox,
    ...(deps.secretVault ? { secretVault: deps.secretVault } : {}),
    // without compaction hooks the strategy only renders. it does not call a model or append an event.
    contextView: (sessionKey) =>
      strategy.build({
        sessionKey,
        events: listEvents(db, sessionKey),
        system: agentDeps.stablePrompt(sessionKey),
        tools: tools.specs(withIntegrations(sessionKey, sessionTools(sessionKey))),
      }),
    resolveApproval: approvals.resolve,
    rules,
    ...(webChannel ? { chat: webChannel.chat } : {}),
  };
}
