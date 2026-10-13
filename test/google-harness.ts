import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { createGoogleAccounts, type GoogleAccounts } from '../src/google/accounts.js';
import { googleConfigSchema, SCOPES, type GoogleConfig } from '../src/google/config.js';
import { createSync, type Sync } from '../src/google/sync.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { createBlobStore, type BlobStore } from '../src/observability/blobs.js';
import { createLogger, type Logger } from '../src/observability/logger.js';
import { startFakeGoogle, type FakeGoogle } from './fake-google.js';

export const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-fake-client-secret-0123456789';
export const refreshOf = (alias: string) => `1//fake-refresh-${alias}-${'r'.repeat(24)}`;

export interface GoogleHarness {
  fake: FakeGoogle;
  db: Db;
  dir: string;
  blobs: BlobStore;
  logger: Logger;
  accounts: GoogleAccounts;
  sync: Sync;
  config: GoogleConfig;
  alerts: Array<{ alias: string; text: string }>;
  secrets: ReturnType<typeof createMemorySecretStore>;
  now: { value: Date };
  // signedIn marks an account as signed in, as a finished sign-in does.
  signedIn(alias: string, at?: string): void;
  // restart makes new accounts and a new sync on the same database, as a new process does.
  restart(): void;
  rows(sql: string, ...params: Array<string | number>): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createGoogleHarness(options: { accounts?: string[]; config?: Partial<GoogleConfig>; db?: Db } = {}): Promise<GoogleHarness> {
  const aliases = options.accounts ?? ['personal', 'school'];
  const fake = await startFakeGoogle();
  fake.grant = [SCOPES.readonly, SCOPES.modify, SCOPES.events, SCOPES.calendarRead, SCOPES.send];
  const dir = mkdtempSync(join(tmpdir(), 'okc-google-'));
  const db = options.db ?? openDb(join(dir, 'okc.sqlite'));
  const now = { value: new Date('2026-10-13T16:00:00Z') };
  const clock = () => now.value;
  const blobs = createBlobStore(db, join(dir, 'blobs'), clock);
  const logger = createLogger({ dir: join(dir, 'logs'), consoleLevel: 'off', clock });
  const config = googleConfigSchema.parse({ clientId: CLIENT_ID, accounts: aliases.map((alias) => ({ alias, email: `${alias}@example.com` })), ...options.config });
  const secrets = createMemorySecretStore({
    'google.client': CLIENT_SECRET,
    ...Object.fromEntries(aliases.map((alias) => [`google.${alias}`, refreshOf(alias)])),
  });
  for (const alias of aliases) fake.addAccount(alias, `${alias}@example.com`, refreshOf(alias));
  const alerts: GoogleHarness['alerts'] = [];
  const endpoints = { apiRoot: fake.url, tokenUrl: `${fake.url}token`, revokeUrl: `${fake.url}revoke`, authUrl: `${fake.url}auth` };
  const harness: GoogleHarness = {
    fake,
    db,
    dir,
    blobs,
    logger,
    config,
    alerts,
    secrets,
    now,
    accounts: undefined as unknown as GoogleAccounts,
    sync: undefined as unknown as Sync,
    signedIn(alias, at = '2026-10-01T00:00:00Z') {
      db.prepare("UPDATE google_accounts SET status = 'ok', email = ?, authorizedAt = ?, alertedAt = NULL WHERE alias = ?").run(`${alias}@example.com`, at, alias);
    },
    restart() {
      harness.accounts = createGoogleAccounts({
        db,
        clock,
        logger,
        secrets,
        config,
        endpoints,
        onNeedsAuth: (alias, text) => alerts.push({ alias, text }),
        onNewMailbox: (alias) => harness.sync.reset(alias),
      });
      harness.sync = createSync({ db, clock, logger, blobs, accounts: harness.accounts, timeZone: 'America/Los_Angeles' });
    },
    rows: (sql, ...params) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    async close() {
      await harness.accounts.close();
      await fake.close();
    },
  };
  harness.restart();
  return harness;
}
