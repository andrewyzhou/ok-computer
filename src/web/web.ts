import { join } from 'node:path';
import { BROWSER_TOOLS, createBrowserTools } from '../browser/tools.js';
import { createBrowserWorker, type BrowserWorker } from '../browser/worker.js';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import type { Logger } from '../observability/logger.js';
import { MAIN_SESSION } from '../sessions/router.js';
import type { Clock } from '../time.js';
import type { Tool } from '../tools/registry.js';
import { publicEgress, type Egress } from './egress.js';
import { createWebSearchTool, type Engine } from './search.js';
import { createWebFetchTool } from './web-fetch.js';

export interface WebOptions {
  egress?: Egress;
  browserArgs?: string[];
  engines?: Engine[];
}

export const WEB_TOOLS: readonly string[] = ['web_fetch', 'web_search', ...BROWSER_TOOLS];

export interface Web {
  tools: Tool[];
  browser: BrowserWorker;
  // the main session and automation runs get the web tools. the heartbeat and the consolidation do not.
  toolsFor(sessionKey: string): readonly string[];
  start(): void;
  stop(): Promise<void>;
}

export function createWeb(deps: { db: Db; blobs: BlobStore; logger: Logger; clock: Clock; config: Config; enabled: boolean } & WebOptions): Web {
  const { db, logger, clock, config } = deps;
  const egress = deps.egress ?? publicEgress;
  const browser = createBrowserWorker({
    db,
    blobs: deps.blobs,
    bytes: createByteStore(db, join(config.paths.data, 'blobs'), clock),
    logger,
    clock,
    dir: join(config.paths.data, 'browser'),
    egress,
    enabled: deps.enabled,
    ...(deps.browserArgs ? { args: deps.browserArgs } : {}),
  });
  return {
    tools: [
      createWebFetchTool({ egress }),
      createWebSearchTool({ db, worker: browser, clock, timeZone: config.timeZone, ...(deps.engines ? { engines: deps.engines } : {}) }),
      ...createBrowserTools(browser),
    ],
    browser,
    toolsFor: (sessionKey) => (sessionKey === MAIN_SESSION || sessionKey.startsWith('auto:') ? WEB_TOOLS : []),
    start() {
      // chrome ends with the process that started it (probe p3), so a task row that is still open belongs to a stopped
      // app. a chat process never runs the browser, so it never closes the rows of the background app.
      try {
        const closed = browser.sweep();
        if (closed) logger.warn('closed the browser tasks of a stopped app', { tasks: closed });
      } catch (err) {
        logger.error('browser sweep failed', { err });
      }
    },
    stop: () => browser.stop(),
  };
}
