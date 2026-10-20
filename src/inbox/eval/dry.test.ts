import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config/load.js';
import type { Config } from '../../config/schema.js';
import { openDb } from '../../db/index.js';
import type { GoogleAccounts } from '../../google/accounts.js';
import { callTool } from '../actions.js';
import { DRAFT_TOOL } from '../drafts.js';
import { startRun } from '../run.js';
import { ReadOnlyRefused, readOnlyGoogle } from '../readonly.js';
import { dryContext, liveDatabaseReason, MODELS_OFF, repoRoots, type DryContext } from './dry.js';

const CLIENT = 'fake-client.apps.googleusercontent.com';

function configOf(raw: Record<string, unknown> = {}): Config {
  const parsed = parseConfig({ google: { clientId: CLIENT, accounts: [{ alias: 'a06' }, { alias: 'school' }] }, ...raw });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

// accounts that never reach google. the tests of the dry context make no request.
const offline: GoogleAccounts = {
  aliases: ['a06', 'school'],
  run: async () => {
    throw new Error('offline');
  },
  unavailable: () => undefined,
  alertPending: async () => undefined,
  saveClient: async () => ({ error: 'offline' }),
  hasClient: async () => true,
  beginSignIn: async () => ({ error: 'offline' }),
  finishSignIn: async () => ({ error: 'offline' }),
  importToken: async () => ({ ok: false, status: 503, error: 'offline' }),
  close: async () => undefined,
};

// a folder shaped like a checkout of the repo, with a live database in data/.
function fakeRepo(): { root: string; live: string } {
  const root = mkdtempSync(join(tmpdir(), 'okc-eval-repo-'));
  mkdirSync(join(root, 'data'));
  const live = join(root, 'data', 'okc.sqlite');
  writeFileSync(live, 'live');
  return { root, live };
}

const opened: DryContext[] = [];
afterEach(async () => {
  for (const each of opened.splice(0)) await each.close();
});

describe('the live database', () => {
  it('is refused at data/okc.sqlite, by path, by a relative path and through a symlink or a hard link', () => {
    const { root, live } = fakeRepo();
    const config = configOf();
    const check = { config, configPath: join(root, 'okc.config.json'), roots: [root] };
    expect(() => dryContext({ dbPath: live, config, configPath: check.configPath, models: false, roots: [root], google: offline })).toThrow(
      /refuses .*data folder of the app/,
    );
    expect(liveDatabaseReason('data/okc.sqlite', { ...check, cwd: root })).toMatch(/data folder/);
    // a path in the data folder that does not exist yet is refused too, because opening it would write there.
    expect(liveDatabaseReason(join(root, 'data', 'other.sqlite'), check)).toMatch(/data folder/);

    const elsewhere = mkdtempSync(join(tmpdir(), 'okc-eval-link-'));
    symlinkSync(live, join(elsewhere, 'okc.sqlite'));
    expect(() => dryContext({ dbPath: join(elsewhere, 'okc.sqlite'), config, configPath: check.configPath, models: false, roots: [root], google: offline })).toThrow(/refuses/);
    symlinkSync(join(root, 'data'), join(elsewhere, 'data-link'));
    expect(liveDatabaseReason(join(elsewhere, 'data-link', 'okc.sqlite'), check)).toMatch(/data folder/);
    linkSync(live, join(elsewhere, 'hard.sqlite'));
    expect(liveDatabaseReason(join(elsewhere, 'hard.sqlite'), check)).toMatch(/link to the live database/);
  });

  it('is refused at the data path of the config', () => {
    const { root } = fakeRepo();
    const other = mkdtempSync(join(tmpdir(), 'okc-eval-data-'));
    const config = configOf({ paths: { data: other } });
    expect(liveDatabaseReason(join(other, 'okc.sqlite'), { config, configPath: join(root, 'okc.config.json'), roots: [root] })).toMatch(/data folder/);
  });

  it('is refused at data/okc.sqlite of this repo', () => {
    const roots = repoRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(liveDatabaseReason(join(root, 'data', 'okc.sqlite'), { config: configOf(), configPath: join(root, 'okc.config.json'), roots })).not.toBeNull();
    }
  });

  it('lets a copy elsewhere through, and refuses a path that does not exist', () => {
    const { root } = fakeRepo();
    const scratch = mkdtempSync(join(tmpdir(), 'okc-eval-copy-'));
    const config = configOf();
    expect(liveDatabaseReason(join(scratch, 'okc.sqlite'), { config, configPath: join(root, 'okc.config.json'), roots: [root] })).toBeNull();
    expect(() => dryContext({ dbPath: join(scratch, 'missing.sqlite'), config, configPath: join(root, 'okc.config.json'), models: false, roots: [root], google: offline })).toThrow(
      /does not exist/,
    );
  });
});

describe('the dry context', () => {
  function open(): DryContext {
    const { root } = fakeRepo();
    const scratch = mkdtempSync(join(tmpdir(), 'okc-eval-copy-'));
    const dbPath = join(scratch, 'okc.sqlite');
    openDb(dbPath).close();
    const dry = dryContext({ dbPath, config: configOf(), configPath: join(root, 'okc.config.json'), models: false, roots: [root], google: offline });
    opened.push(dry);
    return dry;
  }

  it('refuses and records a draft tool call', async () => {
    const dry = open();
    const run = startRun(dry.ctx, 'digest', 'utility');
    const { output, approvalId } = await callTool(dry.ctx, run, DRAFT_TOOL, { account: 'a06', sourceMessageId: 'm1', threadId: 't1', to: ['a@b.example'], subject: 'Re: x', body: 'hi' });
    expect(output.isError).toBe(true);
    expect(output.effect).toBe('none');
    expect(approvalId).toBeNull();
    expect(dry.refusedTools).toEqual([DRAFT_TOOL]);
    expect(dry.ctx.db.prepare('SELECT COUNT(*) AS n FROM inbox_drafts').get()).toEqual({ n: 0 });
    expect(dry.ctx.db.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 0 });
  });

  it('sends nothing to the owner and runs no agent', async () => {
    const dry = open();
    await expect(dry.ctx.owner.send('Inbox digest for today')).resolves.toBe(false);
    expect(dry.sent).toEqual(['Inbox digest for today']);
    await expect(dry.ctx.agent({} as never)).rejects.toThrow(/runs no agent/);
  });

  it('fails each model call when the models are off', async () => {
    const dry = open();
    const result = await dry.ctx.slots.call('utility', { system: 's', messages: [], tools: [] }, { runId: null });
    expect(result).toEqual({ ok: false, error: MODELS_OFF, aborted: false });
  });

  it('wraps the accounts in the read-only view', async () => {
    const dry = open();
    await expect(dry.ctx.google.oneClick('https://list.example/u')).resolves.toMatchObject({ ok: false, refused: true, sent: false });
    expect(dry.google.refused).toEqual(['oneClick https://list.example/u']);
  });

  it('refuses an account that the config does not have', () => {
    const { root } = fakeRepo();
    const scratch = mkdtempSync(join(tmpdir(), 'okc-eval-copy-'));
    const dbPath = join(scratch, 'okc.sqlite');
    openDb(dbPath).close();
    expect(() => dryContext({ dbPath, config: configOf(), configPath: join(root, 'x.json'), models: false, roots: [root], google: offline, accounts: ['nope'] })).toThrow(
      /no account nope/,
    );
  });
});

describe('the read-only view of the check', () => {
  it('wraps a frozen client, runs a read on its own object and still refuses a write', async () => {
    const calls: string[] = [];
    const messages = {
      list(this: unknown) {
        calls.push(this === messages ? 'list on its object' : 'list elsewhere');
        return Promise.resolve({ data: {} });
      },
      modify() {
        calls.push('modify');
        return Promise.resolve({ data: {} });
      },
    };
    // the gmail client of the sdk is frozen in the same way.
    const gmail = Object.freeze({ users: Object.freeze({ messages: Object.freeze(messages) }) });
    const calendar = Object.freeze({ events: Object.freeze({ list: () => Promise.resolve({ data: {} }) }) });
    const accounts: GoogleAccounts = { ...offline, run: (_alias, fn) => fn({ gmail, calendar } as never) };
    const view = readOnlyGoogle(accounts);
    await view.accounts.run('a06', (apis) => apis.gmail.users.messages.list({ userId: 'me' }));
    await expect(view.accounts.run('a06', (apis) => apis.gmail.users.messages.modify({ userId: 'me', id: 'm1' }))).rejects.toBeInstanceOf(ReadOnlyRefused);
    expect(calls).toEqual(['list on its object']);
    expect(view.refused).toEqual(['gmail.users.messages.modify']);
  });
});
