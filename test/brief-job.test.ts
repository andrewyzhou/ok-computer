import { describe, expect, it } from 'vitest';
import type { BriefContext } from '../src/brief/context.js';
import { BRIEF_AUTOMATION_NAME } from '../src/brief/context.js';
import { BRIEF_TASK, runBriefJob } from '../src/brief/job.js';
import { briefOfDay } from '../src/brief/store.js';
import { openDb, type Db } from '../src/db/index.js';
import { silentLogger } from '../src/observability/logger.js';
import { createRunQueue } from '../src/sessions/queue.js';
import { createTestApp } from './app-harness.js';

// the morning brief job (phase 6 t1) end to end: the automation runs at 07:30 local time, builds the brief in code,
// stores it, sends the short text to the owner and copies it into the main session. the app has no google block here,
// so the brief has no calendar, and the digest and the goals come from rows that the test writes.

const TZ = 'America/Los_Angeles';
const DAY = '2026-10-12';
const pdt = (time: string, day = DAY) => new Date(`${day}T${time}:00-07:00`).toISOString();

function digest(db: Db, day: string, accounts: string[]): void {
  db.prepare('INSERT INTO inbox_digests (day, runId, createdAt, accounts, shortText, items) VALUES (?, ?, ?, ?, ?, ?)').run(
    day,
    'run-digest',
    pdt('07:00', day),
    JSON.stringify(accounts),
    'digest',
    '[]',
  );
}

type Owner = BriefContext['owner'];

// a brief context without the app, for the cases that the app cannot set up: a digest that runs, and an owner channel
// that fails.
function context(options: { owner?: Owner; running?: () => boolean; signal?: AbortSignal } = {}) {
  const db = openDb(':memory:');
  const activeRuns = new Set<string>();
  const sent: string[] = [];
  const ctx: BriefContext = {
    db,
    clock: () => new Date(pdt('07:30')),
    logger: silentLogger,
    timeZone: TZ,
    ...(options.running ? { inbox: { running: (job) => job === 'digest' && options.running!() } } : {}),
    owner: options.owner ?? {
      send: async (text) => {
        sent.push(text);
        return true;
      },
      chat: () => ({ channel: 'telegram', chatId: '42' }),
    },
    queue: createRunQueue(),
    dashboardUrl: 'http://127.0.0.1:7777',
    signal: options.signal ?? new AbortController().signal,
    replan: () => {},
    activeRuns,
    newId: () => 'run-b',
  };
  return { db, ctx, sent, activeRuns };
}

const systemEvents = (db: Db, sessionKey: string) =>
  db
    .prepare("SELECT payload FROM events WHERE sessionKey = ? AND type = 'system_event' ORDER BY seq")
    .all(sessionKey)
    .map((row) => JSON.parse(String(row.payload)) as { text: string; taint?: Array<{ source: string; toolName: string; runId: string; toolCallId: string }> });

describe('the morning brief job', () => {
  it('runs at 07:30, stores the brief, sends it to the owner and copies it into the main session', async () => {
    const t = createTestApp([], { start: pdt('07:29'), config: { timeZone: TZ } });
    await t.app.start();
    const automation = t.rows("SELECT name, payload, slot, createdBy FROM automations WHERE json_extract(payload, '$.type') = 'brief'");
    expect(automation).toEqual([{ name: BRIEF_AUTOMATION_NAME, payload: '{"type":"brief"}', slot: 'utility', createdBy: 'system' }]);
    t.db.prepare("INSERT INTO goals (day, title, status, createdAt) VALUES (?, 'finish essay', 'open', ?)").run(DAY, pdt('07:00'));
    digest(t.db, DAY, ['personal']);

    await t.at(pdt('07:30'));

    const briefs = t.rows('SELECT id, day, runId, shortText FROM briefs');
    expect(briefs).toHaveLength(1);
    const brief = briefs[0]!;
    expect(brief.day).toBe(DAY);
    const runs = t.rows('SELECT id, sessionKey, trigger, slot, status, error FROM runs WHERE id = ?', String(brief.runId));
    expect(runs).toEqual([{ id: brief.runId, sessionKey: `brief:${brief.runId}`, trigger: 'automation', slot: 'utility', status: 'completed', error: null }]);
    expect(t.rows('SELECT briefId, channel, ok, error FROM brief_deliveries')).toEqual([{ briefId: brief.id, channel: 'cli', ok: 1, error: null }]);

    const events = systemEvents(t.db, `brief:${brief.runId}`);
    expect(events[0]).toEqual({ text: BRIEF_TASK });
    expect(events[1]).toEqual({
      text: 'The brief read gmail:personal.',
      taint: [{ source: 'gmail:personal', toolName: 'brief', runId: brief.runId, toolCallId: `brief-${brief.runId}`, at: pdt('07:30') }],
    });
    expect(events.at(-1)).toEqual({ text: 'Sent the brief to the owner.' });

    expect(t.printed()).toContain('Brief for Mon 12 Oct');
    expect(t.printed()).toContain('/#/today/2026-10-12');
    expect(String(brief.shortText)).toMatch(/\/#\/today\/2026-10-12$/);

    // the copy in the main session is wrapped, because the brief repeats text of the mail it read.
    const main = systemEvents(t.db, 'main').filter((each) => each.text.startsWith('The morning brief went to the owner:'));
    expect(main).toHaveLength(1);
    expect(main[0]!.text).toContain('<untrusted source="gmail:personal">');
    expect(main[0]!.text).toContain(String(brief.shortText));
    expect(main[0]!.taint?.map((each) => each.source)).toEqual(['gmail:personal']);

    const stored = briefOfDay(t.db, DAY)!;
    expect(stored.content.sources).toEqual({ calendar: 'off', skipped: [], digest: { id: 1, day: DAY }, desk: expect.any(Boolean) });
    expect(stored.delivery).toMatchObject({ channel: 'cli', ok: true });
  });

  it('copies the brief without a wrapper when it read no outside text', async () => {
    const { db, ctx, sent, activeRuns } = context();
    expect(await runBriefJob(ctx)).toEqual({ status: 'completed', runId: 'run-b' });
    expect(sent).toHaveLength(1);
    expect(activeRuns.size).toBe(0);
    // the task, then the line of the delivery. no source was read, so there is no taint event.
    expect(systemEvents(db, 'brief:run-b')).toEqual([{ text: BRIEF_TASK }, { text: 'Sent the brief to the owner.' }]);
    expect(systemEvents(db, 'main')).toEqual([{ text: `The morning brief went to the owner:\n${sent[0]}` }]);
    expect(briefOfDay(db, DAY)?.delivery).toMatchObject({ channel: 'telegram', ok: true, error: null });
  });

  it('waits for the digest of the day while it runs', async () => {
    let running = true;
    const { db, ctx } = context({ running: () => running });
    const job = runBriefJob(ctx, { pollMs: 5, maxWaitMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(db.prepare('SELECT COUNT(*) AS n FROM briefs').get()?.n).toBe(0);
    // the run is there while it waits, so the trace shows it.
    expect(db.prepare("SELECT status FROM runs WHERE id = 'run-b'").get()?.status).toBe('running');
    digest(db, DAY, ['school']);
    running = false;
    expect((await job).status).toBe('completed');
    expect(briefOfDay(db, DAY)?.content.sources.digest).toEqual({ id: 1, day: DAY });
  });

  it('stops waiting after the longest wait, and when the app stops', async () => {
    const slow = context({ running: () => true });
    expect((await runBriefJob(slow.ctx, { pollMs: 5, maxWaitMs: 30 })).status).toBe('completed');
    expect(briefOfDay(slow.db, DAY)).toBeDefined();

    const stop = new AbortController();
    const stopped = context({ running: () => true, signal: stop.signal });
    const job = runBriefJob(stopped.ctx, { pollMs: 10_000, maxWaitMs: 600_000 });
    setTimeout(() => stop.abort(), 10);
    expect((await job).status).toBe('completed');
  });

  it('stores the brief when the owner channel fails, with a delivery that is not ok', async () => {
    const { db, ctx } = context({ owner: { send: async () => false, chat: () => ({ channel: 'telegram', chatId: '42' }) } });
    const result = await runBriefJob(ctx);
    expect(result).toEqual({ status: 'completed', runId: 'run-b', error: 'the message did not reach the owner' });
    expect(briefOfDay(db, DAY)?.delivery).toMatchObject({ channel: 'telegram', ok: false, error: 'the message did not reach the owner' });
    expect(db.prepare("SELECT status, error FROM runs WHERE id = 'run-b'").get()).toEqual({ status: 'completed', error: 'the message did not reach the owner' });
    expect(systemEvents(db, 'brief:run-b').at(-1)).toEqual({ text: 'The brief did not reach the owner.' });
  });

  it('fails the run when the brief cannot be stored, and sends nothing', async () => {
    const { db, ctx, sent, activeRuns } = context();
    db.exec('DROP TABLE brief_deliveries; DROP TABLE briefs');
    const result = await runBriefJob(ctx);
    expect(result).toMatchObject({ status: 'failed', runId: 'run-b', error: expect.stringContaining('briefs') });
    expect(sent).toEqual([]);
    expect(activeRuns.size).toBe(0);
    expect(db.prepare("SELECT status FROM runs WHERE id = 'run-b'").get()?.status).toBe('failed');
  });
});
