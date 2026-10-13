import { join } from 'node:path';
import { runAgent, type AgentDeps } from './agent/loop.js';
import { buildStablePrompt } from './agent/system-prompt.js';
import type { ChannelAdapter } from './channels/types.js';
import type { Config } from './config/schema.js';
import { fullHistory } from './context/full-history.js';
import type { Db } from './db/index.js';
import { createSlotRunner } from './models/slots.js';
import type { ModelClient } from './models/types.js';
import type { Logger } from './observability/logger.js';
import { createRunQueue } from './sessions/queue.js';
import { createRouter, MAIN_SESSION } from './sessions/router.js';
import type { Clock } from './time.js';
import { nowTool } from './tools/now.js';
import { createToolRegistry } from './tools/registry.js';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  clients: Record<string, ModelClient>;
  channels: ChannelAdapter[];
  clock: Clock;
}

export interface App {
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
  const memoryPath = join(config.paths.data, 'memory', 'MEMORY.md');

  const agentDeps: AgentDeps = {
    db,
    slots: createSlotRunner({ db, config, clients: deps.clients, logger, clock }),
    tools: createToolRegistry([nowTool]),
    strategy: fullHistory,
    logger,
    config,
    clock,
    stablePrompt: (sessionKey) =>
      buildStablePrompt({
        workspaceDir: config.paths.workspace,
        timeZone: config.timeZone,
        ...(sessionKey === MAIN_SESSION ? { memoryPath } : {}),
      }),
  };

  const channels = new Map(deps.channels.map((channel) => [channel.id, channel]));
  const router = createRouter({
    db,
    logger,
    clock,
    queue,
    channels,
    agent: (input) => runAgent(agentDeps, input),
    // the cli runs on the owner's own terminal. other channels check their owner id when they are added.
    isOwner: (message) => message.channel === 'cli',
    signal: shutdown.signal,
  });

  return {
    async start() {
      for (const channel of channels.values()) {
        await channel.start((message) => void router.handle(message));
        logger.info('channel started', { channel: channel.id });
      }
    },
    idle: () => queue.drain(),
    async stop() {
      for (const channel of channels.values()) await channel.stop();
      shutdown.abort();
      await queue.drain();
    },
  };
}
