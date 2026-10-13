import { join } from 'node:path';
import { runAgent, type AgentDeps } from './agent/loop.js';
import { buildStablePrompt } from './agent/system-prompt.js';
import { createApprovalFlow, type ApprovalFlow } from './approvals/flow.js';
import { expireApprovals } from './approvals/store.js';
import type { ChannelAdapter } from './channels/types.js';
import type { Config } from './config/schema.js';
import { sinceLastReset } from './context/full-history.js';
import { createTrimAndCompact } from './context/trim-and-compact.js';
import type { Db } from './db/index.js';
import { listEvents } from './events/log.js';
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
import { createSlotRunner } from './models/slots.js';
import type { ModelClient, ModelRequest } from './models/types.js';
import { createBlobStore } from './observability/blobs.js';
import type { Logger } from './observability/logger.js';
import { BUILTIN_RULES, type Rule } from './policy/policy.js';
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
import { createOwnerMessenger } from './sessions/owner.js';
import { createRunQueue } from './sessions/queue.js';
import { createRouter, MAIN_SESSION, MAIN_TOOLS } from './sessions/router.js';
import { localDay, localTime, type Clock } from './time.js';
import { createSkillTools } from './skills/skills.js';
import { createToolCaller } from './tools/caller.js';
import { createMessageOwnerTool } from './tools/message-owner.js';
import { nowTool } from './tools/now.js';
import { createToolRegistry } from './tools/registry.js';
import { createResultReadTool } from './tools/result-read.js';

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
}

function sessionTools(sessionKey: string): readonly string[] {
  if (sessionKey === MAIN_SESSION) return MAIN_TOOLS;
  if (sessionKey.startsWith(HEARTBEAT_PREFIX)) return HEARTBEAT_TOOLS;
  if (sessionKey.startsWith(CONSOLIDATION_PREFIX)) return CONSOLIDATION_TOOLS;
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
  const ownerIds = deps.ownerIds ?? {};
  // in a private telegram chat, the chat id is the same as the user id of the owner.
  const [preferred] = Object.entries(ownerIds).map(([channel, chatId]) => ({ channel, chatId }));
  const owner = createOwnerMessenger({ db, channels, logger, clock, ...(preferred ? { preferred } : {}) });
  const ids = deps.newId ? { newId: deps.newId } : {};
  const blobs = createBlobStore(db, join(config.paths.data, 'blobs'), clock);

  const approvals = createApprovalFlow({
    db,
    clock,
    logger,
    queue,
    owner,
    caller: () => caller,
    signal: shutdown.signal,
  });
  // the scheduler is created below. the tools call replan only after the start.
  const replan = () => scheduler.replan();
  const tools = createToolRegistry(
    [
      nowTool,
      ...createGoalTools({ db, replan }),
      ...createAutomationTools({ db, replan }),
      ...createHeartbeatTools({ db }),
      ...createMemoryTools({ db, memoryDir }),
      ...createConsolidationTools({ db, memoryDir }),
      createMessageOwnerTool(owner),
      ...createSkillTools({ skillsDir: config.paths.skills }),
      createResultReadTool({ db, blobs }),
    ],
  );
  const caller = createToolCaller({
    db,
    blobs,
    tools,
    rules: deps.rules ?? BUILTIN_RULES,
    requestApproval: approvals.request,
    clock,
    timeZone: config.timeZone,
  });

  const slots = createSlotRunner({ db, config, clients: deps.clients, logger, clock });
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
        ...(sessionKey === MAIN_SESSION ? { memoryPath } : {}),
        ...(sessionTools(sessionKey).includes('skill_read') ? { skillsDir: config.paths.skills } : {}),
        // the heartbeat runs often on a small model, so it gets a light prompt.
        ...(sessionKey.startsWith(HEARTBEAT_PREFIX)
          ? { personaFiles: ['USER.md'], extraInstructions: HEARTBEAT_INSTRUCTIONS }
          : {}),
        ...(sessionKey.startsWith(CONSOLIDATION_PREFIX)
          ? { personaFiles: ['USER.md'], extraInstructions: CONSOLIDATION_INSTRUCTIONS }
          : {}),
      }),
    contextLines: (now) => scheduleContext(db, now, config.timeZone),
    ...ids,
  };
  const agent = async (input: Parameters<typeof runAgent>[1]) => {
    const result = await runAgent(agentDeps, input);
    // the router tells the owner about a stopped message run in its reply. a background run has no reply, so the owner gets a message here.
    if (result.stoppedAtLimit && input.trigger !== 'message') {
      await owner.send(`The ${input.trigger} run did not finish: ${result.error}.`);
    }
    return result;
  };

  const heartbeat = createHeartbeat({ db, clock, logger, config, queue, owner, agent, signal: shutdown.signal, ...ids });
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
    signal: shutdown.signal,
    ...ids,
  });
  const scheduler = createScheduler({
    db,
    clock,
    logger,
    config,
    execute: runJob,
    notifyOwner: async (text) => void (await owner.send(text)),
    onTick: (now) => expireApprovals(db, now),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  });

  const router = createRouter({
    db,
    logger,
    clock,
    queue,
    channels,
    agent,
    // the cli runs on the owner's own terminal. other channels check the sender id against the owner id.
    isOwner: (message) => message.channel === 'cli' || ownerIds[message.channel] === message.senderId,
    rememberOwnerChat: owner.remember,
    approvals: approvals.resolve,
    onReset: () => {
      const now = clock();
      const excerpt = sessionExcerpt(sinceLastReset(listEvents(db, MAIN_SESSION)), localTime(now, config.timeZone));
      if (excerpt) appendToDailyNote(memoryDir, localDay(now, config.timeZone), 'notes', excerpt);
    },
    signal: shutdown.signal,
  });

  return {
    scheduler,
    async start() {
      for (const channel of channels.values()) {
        await channel.start((message) => void router.handle(message));
        logger.info('channel started', { channel: channel.id });
      }
      if (installRoutine(db, config, clock())) logger.info('goals routine installed');
      if (installConsolidation(db, config, clock())) logger.info('memory consolidation installed');
      syncHeartbeat(db, config, clock());
      // missed jobs can take minutes, so the start does not wait for them.
      void scheduler.start().catch((err: unknown) => logger.error('scheduler start failed', { err }));
    },
    idle: () => queue.drain(),
    async stop() {
      scheduler.stop();
      for (const channel of channels.values()) await channel.stop();
      shutdown.abort();
      await queue.drain();
    },
    // without compaction hooks the strategy only renders. it does not call a model or append an event.
    contextView: (sessionKey) =>
      strategy.build({
        sessionKey,
        events: listEvents(db, sessionKey),
        system: agentDeps.stablePrompt(sessionKey),
        tools: tools.specs(sessionTools(sessionKey)),
      }),
    resolveApproval: approvals.resolve,
  };
}
