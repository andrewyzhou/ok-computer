import { join } from 'node:path';
import { runAgent, type AgentDeps } from './agent/loop.js';
import { buildStablePrompt } from './agent/system-prompt.js';
import { createApprovalFlow } from './approvals/flow.js';
import { expireApprovals } from './approvals/store.js';
import type { ChannelAdapter } from './channels/types.js';
import type { Config } from './config/schema.js';
import { fullHistory, sinceLastReset } from './context/full-history.js';
import type { Db } from './db/index.js';
import { listEvents } from './events/log.js';
import { installRoutine } from './goals/routine.js';
import { createGoalTools } from './goals/tools.js';
import { appendToDailyNote, sessionExcerpt } from './memory/daily.js';
import { createMemoryTools } from './memory/tools.js';
import { createSlotRunner } from './models/slots.js';
import type { ModelClient } from './models/types.js';
import type { Logger } from './observability/logger.js';
import { scheduleContext } from './scheduler/context.js';
import {
  createHeartbeat,
  createHeartbeatTools,
  HEARTBEAT_INSTRUCTIONS,
  HEARTBEAT_PREFIX,
  syncHeartbeat,
} from './scheduler/heartbeat.js';
import { createJobRunner } from './scheduler/jobs.js';
import { createScheduler, type Scheduler, type SetTimer } from './scheduler/scheduler.js';
import { createAutomationTools } from './scheduler/tools.js';
import { createOwnerMessenger } from './sessions/owner.js';
import { createRunQueue } from './sessions/queue.js';
import { createRouter, MAIN_SESSION } from './sessions/router.js';
import { localDay, localTime, type Clock } from './time.js';
import { createMessageOwnerTool } from './tools/message-owner.js';
import { nowTool } from './tools/now.js';
import { createToolRegistry } from './tools/registry.js';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  clients: Record<string, ModelClient>;
  channels: ChannelAdapter[];
  clock: Clock;
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
}

// the app wires the modules together. main.ts and the integration tests both use it.
export function createApp(deps: AppDeps): App {
  const { config, db, logger, clock } = deps;
  const shutdown = new AbortController();
  const queue = createRunQueue();
  const memoryDir = join(config.paths.data, 'memory');
  const memoryPath = join(memoryDir, 'MEMORY.md');
  const channels = new Map(deps.channels.map((channel) => [channel.id, channel]));
  const owner = createOwnerMessenger({ db, channels, logger, clock });
  const ids = deps.newId ? { newId: deps.newId } : {};

  const approvals = createApprovalFlow({
    db,
    clock,
    logger,
    queue,
    owner,
    timeZone: config.timeZone,
    tools: () => tools,
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
      ...createMemoryTools({ memoryDir }),
      createMessageOwnerTool(owner),
    ],
    { gate: approvals.gate },
  );

  const agentDeps: AgentDeps = {
    db,
    slots: createSlotRunner({ db, config, clients: deps.clients, logger, clock }),
    tools,
    strategy: fullHistory,
    logger,
    config,
    clock,
    stablePrompt: (sessionKey) =>
      buildStablePrompt({
        workspaceDir: config.paths.workspace,
        timeZone: config.timeZone,
        ...(sessionKey === MAIN_SESSION ? { memoryPath } : {}),
        // the heartbeat runs often on a small model, so it gets a light prompt.
        ...(sessionKey.startsWith(HEARTBEAT_PREFIX)
          ? { personaFiles: ['USER.md'], extraInstructions: HEARTBEAT_INSTRUCTIONS }
          : {}),
      }),
    contextLines: (now) => scheduleContext(db, now, config.timeZone),
    ...ids,
  };
  const agent = (input: Parameters<typeof runAgent>[1]) => runAgent(agentDeps, input);

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
    // the cli runs on the owner's own terminal. other channels check their owner id when they are added.
    isOwner: (message) => message.channel === 'cli',
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
  };
}
