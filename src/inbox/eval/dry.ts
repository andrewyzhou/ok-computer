import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, loadSecrets } from '../../config/load.js';
import type { Config } from '../../config/schema.js';
import { openDb, type Db } from '../../db/index.js';
import { createGoogleAccounts, type GoogleAccounts } from '../../google/accounts.js';
import { createRequestTrace } from '../../google/trace.js';
import { createKeyringStore } from '../../integrations/secrets.js';
import { createClients } from '../../models/clients.js';
import { createSlotRunner, type SlotRunner } from '../../models/slots.js';
import { createBlobStore } from '../../observability/blobs.js';
import { createLogger } from '../../observability/logger.js';
import { createRunQueue } from '../../sessions/queue.js';
import type { Clock } from '../../time.js';
import type { ToolCaller } from '../../tools/caller.js';
import type { ToolOutput } from '../../tools/registry.js';
import type { InboxContext } from '../context.js';
import { readOnlyGoogle, type ReadOnlyGoogle } from '../readonly.js';

// the dry context of the quality check: an InboxContext on a copy of the database, with the read-only view of the
// google accounts, a tool caller that refuses every call, an owner messenger that sends nothing and no agent. a job
// that runs in it can read mail and write rows of the copy, and nothing else.

// the text of a model call when the check runs without models.
export const MODELS_OFF = 'models are off for this check';

// the real path of a file. a file that does not exist yet gets the real path of its folder, so a symlink of the folder
// still resolves.
export function realPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

// true when path is the folder or inside it. both are real paths.
export function insideFolder(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// the folder of this module, so the repo roots are found from the code and not from the folder the check runs in.
const HERE = dirname(fileURLToPath(import.meta.url));

// the folders of the repo: the checkout of this code and, for a worktree, the main checkout that holds data/. a
// folder that git cannot name is left out.
export function repoRoots(from: readonly string[] = [HERE, process.cwd()]): string[] {
  const roots = new Set<string>();
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  for (const cwd of from) {
    try {
      roots.add(realPath(git(cwd, ['rev-parse', '--show-toplevel'])));
      roots.add(realPath(dirname(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))));
    } catch {
      // not a git checkout.
    }
  }
  return [...roots];
}

export interface LiveCheck {
  config: Pick<Config, 'paths'>;
  // the config file. its folder is where the app resolves paths.data when it runs from there.
  configPath: string;
  roots: readonly string[];
  cwd?: string;
}

// liveDatabaseReason gives the reason why dbPath is the live database of the app, or null for a copy elsewhere. the
// live database is okc.sqlite in paths.data, which the app opens relative to the folder that it runs in, so the check
// tries the folder of the config, the current folder and each repo root. any path in such a data folder or in the
// data folder of a repo is refused, also through a symlink or a hard link.
export function liveDatabaseReason(dbPath: string, check: LiveCheck): string | null {
  const cwd = check.cwd ?? process.cwd();
  const target = realPath(resolve(cwd, dbPath));
  const bases = [dirname(resolve(cwd, check.configPath)), cwd, ...check.roots];
  const folders = new Set<string>();
  for (const base of bases) folders.add(realPath(resolve(base, check.config.paths.data)));
  for (const root of check.roots) folders.add(realPath(join(root, 'data')));
  for (const folder of folders) {
    if (insideFolder(target, folder)) return 'the path is in the data folder of the app, which holds the live database';
    const live = join(folder, 'okc.sqlite');
    if (existsSync(live) && existsSync(target)) {
      const a = statSync(live);
      const b = statSync(target);
      if (a.dev === b.dev && a.ino === b.ino) return 'the path is a link to the live database';
    }
  }
  return null;
}

// forward gives a view of a client object that reads each property from the real one. the gmail client of the sdk is
// frozen, and a proxy must give back the real value of a frozen property, so the guard of readonly.ts cannot wrap the
// client itself and fails on the first call. the view has no own properties, so the guard can wrap it, and every call
// still goes through the guard. a method runs on its real object.
export function forward<T extends object>(target: T): T {
  return new Proxy(Object.create(null) as T, {
    get(_view, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof key === 'symbol') return value;
      if (typeof value === 'function') return (...args: unknown[]) => (value as (...input: unknown[]) => unknown).apply(target, args);
      if (value !== null && typeof value === 'object') return forward(value);
      return value;
    },
  });
}

// forwarded gives the accounts with the apis of each run as views of forward, for readOnlyGoogle.
export function forwarded(accounts: GoogleAccounts): GoogleAccounts {
  return {
    aliases: accounts.aliases,
    run: (alias, fn) => accounts.run(alias, (apis) => fn({ gmail: forward(apis.gmail), calendar: forward(apis.calendar) })),
    unavailable: (alias) => accounts.unavailable(alias),
    alertPending: () => accounts.alertPending(),
    saveClient: (file) => accounts.saveClient(file),
    hasClient: () => accounts.hasClient(),
    beginSignIn: (alias) => accounts.beginSignIn(alias),
    finishSignIn: (state, code) => accounts.finishSignIn(state, code),
    importToken: (alias, input) => accounts.importToken(alias, input),
    close: () => accounts.close(),
  };
}

// the tool caller of the check. each call is refused before the policy, recorded by its tool name, and reported to the
// job as an error with no effect, so the job goes on without a draft or a proposal.
export function dryCaller(refused: string[]): ToolCaller {
  const refuse = (name: string): ToolOutput => {
    refused.push(name);
    return { content: `${name} did not run: the read-only check refuses every tool call.`, isError: true, effect: 'none' };
  };
  return {
    call: async (call) => refuse(call.name),
    notRun: (call) => refuse(call.name),
    callApproved: async (approval) => ({ started: false, output: refuse(approval.toolName) }),
  };
}

// the slot runner of a check without models. every call fails, as a failed model call does, so a job notes it and
// goes on.
export const modelsOff: SlotRunner = {
  call: async () => ({ ok: false, error: MODELS_OFF, aborted: false }),
};

export interface DryOptions {
  dbPath: string;
  config: Config;
  configPath: string;
  // the real slot runner on the configured slots when true, else a runner whose every call fails.
  models: boolean;
  // the accounts to check. the default is every account of the config.
  accounts?: readonly string[];
  // the folders of the repo for the live check. the default asks git.
  roots?: readonly string[];
  // the seams of the tests: an open database, the google accounts to wrap, a slot runner and a clock. a test that
  // gives the database still gives its path, so the live check runs.
  db?: Db;
  google?: GoogleAccounts;
  slots?: SlotRunner;
  clock?: Clock;
}

export interface DryContext {
  ctx: InboxContext;
  google: ReadOnlyGoogle;
  // the tool names that the dry caller refused, in order.
  refusedTools: string[];
  // the texts that a job gave to the owner messenger. they hold mail text, so they stay in memory and are never printed.
  sent: string[];
  close(): Promise<void>;
}

// dryContext builds the context of the check. it refuses the live database and a path that does not exist, because
// opening a new path would make an empty database. the blobs and the log of the run go next to the copy.
export function dryContext(options: DryOptions): DryContext {
  const { config } = options;
  if (!config.google) throw new Error('the config has no google block, so there is no account to check');
  const roots = options.roots ?? repoRoots();
  const reason = liveDatabaseReason(options.dbPath, { config, configPath: options.configPath, roots });
  if (reason) throw new Error(`the check refuses ${options.dbPath}: ${reason}. make a copy with sqlite3 data/okc.sqlite ".backup <scratch>/okc.sqlite"`);
  const dbPath = resolve(options.dbPath);
  if (!options.db && !existsSync(dbPath)) throw new Error(`${options.dbPath} does not exist. make a copy with sqlite3 data/okc.sqlite ".backup <scratch>/okc.sqlite"`);

  const known = new Set(config.google.accounts.map((each) => each.alias));
  const unknown = (options.accounts ?? []).filter((alias) => !known.has(alias));
  if (unknown.length) throw new Error(`the config has no account ${unknown.join(', ')}`);
  const chosen = options.accounts?.length ? new Set(options.accounts) : known;
  const googleConfig = { ...config.google, accounts: config.google.accounts.filter((each) => chosen.has(each.alias)) };

  const clock = options.clock ?? (() => new Date());
  const scratch = dirname(dbPath);
  const db = options.db ?? openDb(dbPath);
  const logger = createLogger({ dir: join(scratch, 'logs'), consoleLevel: 'off', clock });
  const blobs = createBlobStore(db, join(scratch, 'blobs'), clock);
  // a refresh token that google rotates is stored by the accounts code as the app does, so the live sign-in keeps
  // working. the needs-auth message is refused: the check never writes to the owner.
  const accounts =
    options.google ??
    createGoogleAccounts({
      db,
      clock,
      logger,
      secrets: createKeyringStore(),
      config: googleConfig,
      trace: createRequestTrace({ db, blobs, logger, clock }),
      onNeedsAuth: async () => false,
    });
  const google = readOnlyGoogle(forwarded(accounts));

  let slots: SlotRunner = modelsOff;
  if (options.slots) slots = options.slots;
  else if (options.models) {
    // the keys of the model providers come from the .env next to the config, as for the app. nothing writes it.
    loadDotEnv(join(dirname(resolve(options.configPath)), '.env'));
    const clients = createClients(config, loadSecrets());
    if (!clients.ok) throw new Error(`the models cannot run: ${clients.error}`);
    slots = createSlotRunner({ db, config, clients: clients.value, logger, clock });
  }

  const refusedTools: string[] = [];
  const caller = dryCaller(refusedTools);
  const sent: string[] = [];
  const stop = new AbortController();
  const ctx: InboxContext = {
    db,
    clock,
    logger,
    blobs,
    timeZone: config.timeZone,
    google,
    googleConfig,
    slots,
    caller: () => caller,
    owner: {
      send: async (text) => {
        sent.push(text);
        return false;
      },
      chat: () => undefined,
    },
    agent: async () => {
      throw new Error('the read-only check runs no agent');
    },
    queue: createRunQueue(),
    signal: stop.signal,
    activeRuns: new Set(),
    newId: randomUUID,
  };
  return {
    ctx,
    google,
    refusedTools,
    sent,
    async close() {
      stop.abort();
      await ctx.queue.drain();
      // a test that gave the accounts or the database closes them itself.
      if (!options.google) await accounts.close();
      if (!options.db) db.close();
    },
  };
}
