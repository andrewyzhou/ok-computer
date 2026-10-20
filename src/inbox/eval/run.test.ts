import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../../test/google-harness.js';
import type { Config } from '../../config/schema.js';
import { parseConfig } from '../../config/load.js';
import { openDb, type Db } from '../../db/index.js';
import { fromAddress, header } from '../../google/mime.js';
import type { SlotRunner } from '../../models/slots.js';
import type { FakeMessage } from '../../../test/fake-google.js';
import { CORPUS, OWNER, TIME_ZONE } from '../testdata/corpus.js';
import { mailMessage } from '../testdata/build.js';
import { formatReport } from './metrics.js';
import { MAX as DIGEST_MAX } from '../digest.js';
import { setGmailPaceForTests } from '../gmail.js';
import { runInboxEval, type EvalJob } from './run.js';

// the check of the quality check: the corpus delivered to the five accounts of a fake google, read through the dry
// context on a copy of a database. no request leaves the machine.

// the functions of the jobs run as they are. a job in broken throws from one of its functions, so a test can check
// that the error of one job stops only that job.
const flags = vi.hoisted(() => ({ broken: new Set<string>() }));

// sync runs the real function, or throws while its job is broken.
function sync<T>(job: string, name: string, real: () => T): T {
  if (flags.broken.has(job)) throw new Error(`${name} broke for the test`);
  return real();
}

vi.mock('../classify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../classify.js')>();
  return {
    ...real,
    classifyMail: (message: gmail_v1.Schema$Message, owner: ReadonlySet<string>) => sync('digest', 'classifyMail', () => real.classifyMail(message, owner)),
  };
});

vi.mock('../deadlines.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../deadlines.js')>();
  return {
    ...real,
    findDates: (text: string, sentAt: string, timeZone: string) => sync('deadlines', 'findDates', () => real.findDates(text, sentAt, timeZone)),
  };
});

vi.mock('../receipts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../receipts.js')>();
  return {
    ...real,
    amountsIn: (text: string) => sync('subscriptions', 'amountsIn', () => real.amountsIn(text)),
  };
});

vi.mock('../senders.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../senders.js')>();
  return {
    ...real,
    senderIdentityOf: (message: gmail_v1.Schema$Message) => sync('newsletters', 'senderIdentityOf', () => real.senderIdentityOf(message)),
  };
});

const ALIASES = Object.keys(OWNER);
const ALL: EvalJob[] = ['digest', 'subscriptions', 'newsletters', 'deadlines'];

// a corpus mail in the shape of the fake google.
function fakeOf(spec: (typeof CORPUS)[number]['spec']): FakeMessage {
  const built = mailMessage(spec);
  const headers = Object.fromEntries(Object.entries(spec.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0]! : value]));
  return {
    id: spec.id,
    threadId: spec.threadId ?? spec.id,
    labelIds: spec.labels ?? ['INBOX', 'UNREAD'],
    headers,
    ...(spec.plain !== undefined ? { body: spec.plain } : {}),
    ...(spec.html !== undefined ? { html: spec.html } : {}),
    internalDate: built.internalDate!,
  };
}

// the rows of every table, so a test can tell whether a database changed.
function snapshot(db: Db): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
}

let harness: GoogleHarness;
let copy: Db;
let copyPath: string;
let live: Db;
let config: Config;
let root: string;

beforeEach(async () => {
  flags.broken.clear();
  root = mkdtempSync(join(tmpdir(), 'okc-eval-run-'));
  // the live database of this test: the check must never touch it.
  live = openDb(join(root, 'live.sqlite'));
  live.prepare("INSERT INTO settings (key, value, updatedAt) VALUES ('marker', '1', '2026-10-19T00:00:00Z')").run();
  mkdirSync(join(root, 'scratch'));
  copyPath = join(root, 'scratch', 'okc.sqlite');
  live.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
  copy = openDb(copyPath);
  harness = await createGoogleHarness({ accounts: ALIASES, db: copy });
  harness.now.value = new Date('2026-10-19T16:00:00Z');
  for (const alias of ALIASES) harness.signedIn(alias);
  // the fake does not parse a gmail search, so each search gives every mail of the account.
  harness.fake.search = (_alias, _q, messages) => messages;
  for (const mail of CORPUS) harness.fake.deliver(mail.account, fakeOf(mail.spec));
  const parsed = parseConfig({ timeZone: TIME_ZONE, google: { clientId: 'fake-client.apps.googleusercontent.com', accounts: ALIASES.map((alias) => ({ alias, email: OWNER[alias] })) } });
  if (!parsed.ok) throw new Error(parsed.error);
  config = parsed.value;
});

afterEach(async () => {
  setGmailPaceForTests();
  await harness.close();
  copy.close();
  live.close();
});

// a model that puts each mail from the professor in needs_reply with a due date, writes a short draft, and finds no
// charge.
function fakeModel(): SlotRunner {
  const prof = CORPUS.find((each) => each.spec.id === 'c-prof')!;
  return {
    async call(_slot, request) {
      const tool = request.tools[0]!.name;
      const first = request.messages[0];
      const text = first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : '';
      const items: unknown[] = [];
      if (tool === 'digest_items') {
        for (const match of text.matchAll(/^item (\d+):\nFrom: (.*)$/gm)) {
          if (match[2] === prof.spec.headers.From) items.push({ id: Number(match[1]), section: 'needs_reply', summary: 'Answer the check-in question.', dueAt: '2026-10-21', dueText: 'by Wednesday' });
        }
      } else if (tool === 'write_draft') {
        items.push({ id: 1, body: 'Thursday works.' });
      }
      const toolCalls = tool === 'record_charges' ? [] : [{ id: 'c1', name: tool, input: { items } }];
      return {
        ok: true,
        provider: 'fake',
        model: 'fake',
        modelCallId: 1,
        response: { content: [], toolCalls, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      } as never;
    },
  };
}

const run = (jobs: EvalJob[] = ALL, extra: { models?: boolean; slots?: SlotRunner; accounts?: string[]; labelsPath?: string } = {}) =>
  runInboxEval(
    {
      dbPath: copyPath,
      configPath: join(root, 'okc.config.json'),
      jobs,
      models: extra.models ?? false,
      ...(extra.accounts ? { accounts: extra.accounts } : {}),
      ...(extra.labelsPath ? { labelsPath: extra.labelsPath } : {}),
    },
    { config, db: copy, google: harness.accounts, clock: () => harness.now.value, roots: [join(root, 'repo')], commit: 'test', ...(extra.slots ? { slots: extra.slots } : {}) },
  );

describe('runInboxEval', () => {
  it('covers each account', async () => {
    const report = await run();
    expect(report.accounts.map((each) => each.alias)).toEqual(ALIASES);
    for (const each of report.accounts) {
      const delivered = CORPUS.filter((mail) => mail.account === each.alias).length;
      expect(each).toMatchObject({ read: true, error: null });
      expect(each.digest).toEqual({ listed: delivered, limit: DIGEST_MAX, capped: false });
      expect(each.subscriptions.listed).toBe(delivered);
      expect(each.newsletters.listed).toBe(delivered);
      expect(each.htmlOnly).not.toBeNull();
    }
    expect(report.digest?.messages).toBe(CORPUS.length);
    expect(report.digest!.person + report.digest!.list + report.digest!.automated).toBe(CORPUS.length);
    expect(report.subscriptions?.receipts).toBe(CORPUS.length);
    expect(report.newsletters?.senders).toBeGreaterThan(0);
    expect(report.deadlines?.mails).toBe(CORPUS.length);
    expect(report.failures).toEqual([]);
    expect(report.commit).toBe('test');
    expect(report.models.utility?.length).toBeGreaterThan(0);
    // the text of the report holds no address and no subject of the corpus.
    const text = formatReport(report);
    for (const mail of CORPUS) {
      expect(text).not.toContain(String(mail.spec.headers.Subject));
      expect(text).not.toContain(fromAddress(String(mail.spec.headers.From)) ?? '@');
    }
  });

  it('checks only the accounts that it is given', async () => {
    const report = await run(['newsletters'], { accounts: ['hkn'] });
    expect(report.accounts.map((each) => each.alias)).toEqual(['hkn']);
    expect(report.digest).toBeNull();
    expect(report.newsletters?.messages).toBeGreaterThan(0);
  });

  it.each(ALL)('gives null and a failure for %s when one of its functions throws, and runs the other jobs', async (job) => {
    flags.broken.add(job);
    const report = await run();
    expect(report[job]).toBeNull();
    expect(report.failures.some((each) => each.startsWith(`${job}: the check failed: `) && each.includes('broke for the test'))).toBe(true);
    for (const other of ALL.filter((each) => each !== job)) expect(report[other]).not.toBeNull();
    expect(formatReport(report)).toContain(`${job}\n  failed, see the failures`);
  });

  it('makes no call that google refuses', async () => {
    const report = await run();
    expect(report.refusedGoogle).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(harness.fake.requests.filter((each) => each.method !== 'GET' && !each.path.startsWith('/token'))).toEqual([]);
  });

  it('writes no row outside the copy, and no inbox row without models', async () => {
    const before = snapshot(live);
    const copyBefore = snapshot(copy);
    await run();
    expect(snapshot(live)).toEqual(before);
    const copyAfter = snapshot(copy);
    const changed = Object.keys(copyAfter).filter((name) => copyAfter[name] !== copyBefore[name]);
    // the accounts code records each google request and its body in the copy, as the app does.
    expect(changed.filter((name) => !['google_requests', 'blobs', 'google_accounts'].includes(name))).toEqual([]);
    // the blobs and the log of the check go next to the copy, and nothing else appears.
    expect(readdirSync(root).filter((name) => !name.startsWith('live.sqlite'))).toEqual(['scratch']);
  });

  it('runs the digest and the scan with models on the copy, and the dry caller refuses their tool calls', async () => {
    const slots = fakeModel();
    const before = snapshot(live);
    const report = await run(['digest', 'subscriptions', 'deadlines'], { models: true, slots });
    expect(snapshot(live)).toEqual(before);
    // the professor wrote one mail to the owner and one to the course list. the fake model puts both in needs_reply. a
    // person wrote the list mail to a discussion list, so it stays, after the mail to the owner, and it gets no draft.
    // no machine wrote either, so the bar holds.
    expect(report.digest).toMatchObject({ models: true, needsReply: 2, items: 2, automatedInNeedsReply: 0, needsReplyFirst: true });
    expect(report.failures.filter((each) => each.includes('needs-reply items come from mail that no person wrote'))).toEqual([]);
    expect(report.deadlines).toMatchObject({ models: true, given: 2 });
    expect(report.subscriptions?.models).toBe(true);
    expect(report.refusedGoogle).toEqual([]);
    // the draft of the needs-reply item is a tool call, which the dry caller refuses. it is listed, and it is no failure.
    expect(report.refusedTools.length).toBeGreaterThan(0);
    expect(report.failures.filter((each) => each.startsWith('google') || each.includes('model run failed'))).toEqual([]);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM inbox_drafts').get()).toEqual({ n: 0 });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM inbox_digests').get()).toEqual({ n: 1 });
  });

  it('measures against a labels file outside the repo, and refuses one inside it', async () => {
    const labelsPath = join(mkdtempSync(join(tmpdir(), 'okc-eval-labels-')), 'labels.json');
    writeFileSync(
      labelsPath,
      JSON.stringify({
        messages: {
          'school:c-prof': { needsReply: true, kind: 'person', due: '2026-10-21' },
          'school:c-course-list': { needsReply: false, kind: 'list', due: null },
        },
        subscriptions: {},
      }),
    );
    const report = await run(['digest', 'deadlines'], { models: true, slots: fakeModel(), labelsPath });
    // the label says that the course list mail needs no reply, and the fake model put it in needs_reply anyway.
    expect(report.digest).toMatchObject({ labelled: 2, needsReplyRecall: 1, needsReplyPrecision: 0.5, kindAccuracy: 1, labels: true });
    expect(report.deadlines?.dueAccuracy).not.toBeNull();

    const inside = join(root, 'repo', 'labels.json');
    mkdirSync(join(root, 'repo'));
    writeFileSync(inside, '{}');
    await expect(run(['digest'], { labelsPath: inside })).rejects.toThrow(/outside the repo/);
    writeFileSync(labelsPath, JSON.stringify({ messages: { 'no-colon': {} } }));
    await expect(run(['digest'], { labelsPath })).rejects.toThrow(/labels file is invalid/);
  });

  it('waits and reads again when google limits the rate', async () => {
    const waits: number[] = [];
    setGmailPaceForTests({ burst: 1e9, sleep: async (ms) => void waits.push(ms) });
    harness.fake.fault({ route: 'GET /gmail/v1/users/me/messages', status: 429, body: { error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } }, times: 2 });
    const report = await run(['newsletters']);
    expect(waits).toEqual([30_000, 60_000]);
    expect(report.accounts.every((each) => each.read)).toBe(true);
    expect(report.newsletters?.messages).toBeGreaterThan(0);
  });

  it('reports an account that it cannot read, and reads the others', async () => {
    copy.prepare("UPDATE google_accounts SET status = 'needs_auth' WHERE alias = 'hkn'").run();
    const report = await run(['digest']);
    const hkn = report.accounts.find((each) => each.alias === 'hkn')!;
    expect(hkn).toMatchObject({ read: false });
    expect(hkn.error).toMatch(/sign in again/);
    expect(report.accounts.filter((each) => each.read).map((each) => each.alias)).toEqual(['a06', 'yurun', 'a581', 'school']);
    expect(report.failures).toContain('hkn: the account could not be read');
  });
});
