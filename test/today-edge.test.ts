import { afterEach, describe, expect, it } from 'vitest';
import type { BriefContext } from '../src/brief/context.js';
import { runBriefJob } from '../src/brief/job.js';
import { briefOfDay, getBrief, listBriefs, saveBrief } from '../src/brief/store.js';
import { createToday } from '../src/brief/today.js';
import type { BriefContent, BriefsPage } from '../src/dashboard/brief-types.js';
import type { CalendarEvent, CalendarPage } from '../src/dashboard/calendar-types.js';
import { openDb } from '../src/db/index.js';
import { silentLogger } from '../src/observability/logger.js';
import { createRunQueue } from '../src/sessions/queue.js';
import { seedToday } from './seed-today.js';

// adversarial cases of the today track (phase 6 t1): the routes with odd input, the stored briefs, the brief job
// around midnight, and two briefs at once.

const TZ = 'America/Los_Angeles';

type Seeded = ReturnType<typeof seedToday>;
let seeded: Seeded | undefined;
const seed = (options: Parameters<typeof seedToday>[0] = {}) => (seeded = seedToday(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

const json = { 'content-type': 'application/json' };

function ev(id: string, start: string, end: string, fields: Partial<CalendarEvent> = {}): CalendarEvent {
  const startAt = new Date(start).toISOString();
  return {
    key: `personal/primary/${id}`,
    uid: `${id}@google.com`,
    account: 'personal',
    calendarId: 'primary',
    calendarKey: 'personal/primary',
    eventId: id,
    title: id,
    startAt,
    endAt: new Date(end).toISOString(),
    allDay: false,
    startDay: '2026-10-12',
    endDay: '2026-10-12',
    location: null,
    videoUrl: null,
    status: 'confirmed',
    answer: null,
    organizerSelf: true,
    organizer: null,
    guests: [],
    showsAsFree: false,
    recurring: false,
    notes: null,
    htmlLink: null,
    ...fields,
  };
}

// the calendar of the seeded dashboard answers these events, whatever the range.
function withEvents(events: CalendarEvent[]) {
  const { dashboard, db, today } = seed({ calendar: 'empty' });
  today.calendar = async () => ({ configured: true, calendars: [], events, skipped: [] });
  return { dashboard, db };
}

async function page(dashboard: Seeded['dashboard'], path: string): Promise<CalendarPage> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as CalendarPage;
}

describe('the calendar route with odd events', () => {
  it('leaves out declined and cancelled events and events shown as free from the conflicts', async () => {
    const { dashboard } = withEvents([
      ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00'),
      ev('declined', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { answer: 'declined', organizerSelf: false }),
      ev('cancelled', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { status: 'cancelled' }),
      ev('free', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { showsAsFree: true }),
      ev('maybe', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { answer: 'tentative', organizerSelf: false }),
      ev('open', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { answer: 'needsAction', organizerSelf: false }),
    ]);
    const answer = await page(dashboard, '/api/calendar?from=2026-10-12&days=1');
    expect(answer.conflicts).toEqual([]);
    expect(answer.invites).toEqual(['personal/primary/open']);
  });

  it('gives a conflict that touches two days once, and keeps the events in start order', async () => {
    const { dashboard } = withEvents([
      ev('late', '2026-10-12T23:30:00-07:00', '2026-10-13T00:30:00-07:00'),
      ev('night', '2026-10-12T23:45:00-07:00', '2026-10-13T01:00:00-07:00'),
      ev('early', '2026-10-12T08:00:00-07:00', '2026-10-12T08:30:00-07:00'),
    ]);
    const answer = await page(dashboard, '/api/calendar?from=2026-10-12&days=2');
    expect(answer.events.map((each) => each.eventId)).toEqual(['early', 'late', 'night']);
    expect(answer.conflicts).toEqual([{ a: 'personal/primary/late', b: 'personal/primary/night', startAt: answer.events[2]!.startAt, endAt: answer.events[1]!.endAt }]);
  });

  it('leaves out a proposal whose times cannot be read, and keeps one with an end before its start', async () => {
    const { dashboard, db } = withEvents([]);
    const insert = db.prepare(
      `INSERT INTO inbox_proposals (id, account, calendarId, kind, title, startAt, endAt, allDay, description, sourceMessageId, sourceSubject, dedupeKey, state,
         approvalId, eventId, error, runId, createdAt, resolvedAt)
       VALUES (?, 'school', 'primary', 'other', ?, ?, ?, ?, NULL, ?, ?, ?, 'proposed', NULL, NULL, NULL, 'run-digest-1', '2026-10-12T14:00:00Z', NULL)`,
    );
    insert.run(1, 'garbage', 'next friday', null, 0, 'm-1', 's', 'd-1');
    insert.run(2, 'garbage day', 'soon', null, 1, 'm-2', 's', 'd-2');
    insert.run(3, 'backwards', '2026-10-12T17:00:00.000Z', '2026-10-12T16:00:00.000Z', 0, 'm-3', 's', 'd-3');
    insert.run(4, '<img src=x onerror=alert(1)>', '2026-10-13', null, 1, 'm-4', 's', 'd-4');
    const answer = await page(dashboard, '/api/calendar?from=2026-10-12&days=7');
    expect(answer.proposals.map((each) => each.proposalId)).toEqual([3, 4]);
    // the title is data in the json, and the page renders it as text.
    expect(answer.proposals[1]!.title).toBe('<img src=x onerror=alert(1)>');
  });

  it('starts at the local day of now, not the utc day', async () => {
    // the seeded now is 07:30 in los angeles. at 23:30 in los angeles, utc is already the next day.
    const { dashboard, today } = seed({ calendar: 'empty' });
    expect((await page(dashboard, '/api/calendar')).from).toBe('2026-10-12');
    expect(today.ranges[0]).toEqual({ startAt: '2026-10-12T07:00:00.000Z', endAt: '2026-10-19T07:00:00.000Z' });
  });

  it('keeps local midnight across the start of daylight saving time', async () => {
    const { dashboard } = seed({ calendar: 'empty' });
    const answer = await page(dashboard, '/api/calendar?from=2026-03-08&days=1');
    // midnight is at utc-8, and the next midnight at utc-7, so the day has 23 hours.
    expect([answer.startAt, answer.endAt]).toEqual(['2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z']);
  });

  it('ignores a repeated or odd query key', async () => {
    const { dashboard } = seed({ calendar: 'empty' });
    expect((await page(dashboard, '/api/calendar?from=2026-10-12&from=2026-10-13&days=3&x=1')).days.length).toBe(3);
    expect((await dashboard.request('/api/calendar?from=2026-10-12%00')).status).toBe(400);
    expect((await dashboard.request("/api/calendar?from=2026-10-12'--")).status).toBe(400);
  });
});

describe('the brief routes with odd input', () => {
  it('gives 400 for a body that is not a json object, and 415 without json', async () => {
    const { dashboard } = seed();
    for (const body of ['[]', 'null', '"08:00"', '{"time":8}', '{"time":"08:00","extra":1}', '{"time":"08:00\\n"}', '{"time":"０８:００"}', 'not json']) {
      const response = await dashboard.request('/api/brief/schedule', { method: 'PUT', headers: json, body });
      expect(response.status, body).toBe(400);
      const answer = (await response.json()) as { error: string };
      expect(Object.keys(answer), body).toEqual(['error']);
    }
    expect((await dashboard.request('/api/brief/schedule', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{"time":"08:00"}' })).status).toBe(415);
    expect((await dashboard.request('/api/brief/run', { method: 'POST', headers: json, body: '{"force":true}' })).status).toBe(400);
  });

  it('keeps the schedule when a bad body comes', async () => {
    const { dashboard } = seed();
    await dashboard.request('/api/brief/schedule', { method: 'PUT', headers: json, body: '{"time":"08:15"}' });
    await dashboard.request('/api/brief/schedule', { method: 'PUT', headers: json, body: '{"time":"25:00"}' });
    const schedule = (await (await dashboard.request('/api/brief/schedule')).json()) as { time: string };
    expect(schedule.time).toBe('08:15');
  });

  it('answers a brief whose stored text holds hostile text as json', async () => {
    const { dashboard, db } = seed({ empty: true });
    const content: BriefContent = {
      day: '2026-10-12',
      timeZone: TZ,
      generatedAt: '2026-10-12T14:30:00.000Z',
      sections: [{ kind: 'day', title: 'Today', note: '</script><script>alert(1)</script>', items: [] }],
      sources: { calendar: 'ok', skipped: [], digest: null, desk: false },
    };
    saveBrief(db, { day: '2026-10-12', runId: null, shortText: 'x y', content }, new Date('2026-10-12T14:30:00Z'));
    const response = await dashboard.request('/api/briefs/day/2026-10-12');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(((await response.json()) as { content: BriefContent }).content.sections[0]!.note).toBe('</script><script>alert(1)</script>');
  });

  it('gives 404 for a path id with a sign, a space or a huge value', async () => {
    const { dashboard } = seed();
    for (const id of ['+1', '%201', '1%20', '1.0', '0x1', '9007199254740993', '１']) {
      expect((await dashboard.request(`/api/briefs/${id}`)).status, id).toBe(404);
    }
  });
});

describe('the stored briefs', () => {
  const content = (day: string): BriefContent => ({ day, timeZone: TZ, generatedAt: `${day}T14:30:00.000Z`, sections: [], sources: { calendar: 'off', skipped: [], digest: null, desk: false } });

  it('never changes or deletes a brief or a delivery', () => {
    const db = openDb(':memory:');
    const brief = saveBrief(db, { day: '2026-10-12', runId: null, shortText: 'a', content: content('2026-10-12') }, new Date());
    db.prepare('INSERT INTO brief_deliveries (briefId, channel, ok, error, at) VALUES (?, NULL, 0, NULL, ?)').run(brief.id, new Date().toISOString());
    expect(() => db.prepare("UPDATE briefs SET shortText = 'b'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM briefs').run()).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE brief_deliveries SET ok = 1').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM brief_deliveries').run()).toThrow(/append-only/);
  });

  it('gives the newest brief of a day, and pages every brief once', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 7; i++) saveBrief(db, { day: i % 2 ? '2026-10-12' : '2026-10-11', runId: `r${i}`, shortText: `t${i}`, content: content('2026-10-12') }, new Date());
    expect(briefOfDay(db, '2026-10-12')?.runId).toBe('r5');
    expect(getBrief(db, 'latest')?.runId).toBe('r6');
    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const next: BriefsPage = listBriefs(db, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...next.briefs.map((each) => each.id));
      if (!next.nextCursor) break;
      cursor = next.nextCursor;
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
});

describe('the brief job around midnight and at once', () => {
  function context(now: string, sent: string[] = []) {
    const db = openDb(':memory:');
    let ids = 0;
    const ctx: BriefContext = {
      db,
      clock: () => new Date(now),
      logger: silentLogger,
      timeZone: TZ,
      owner: {
        send: async (text) => {
          sent.push(text);
          return true;
        },
        chat: () => ({ channel: 'telegram', chatId: '42' }),
      },
      queue: createRunQueue(),
      dashboardUrl: 'http://127.0.0.1:7777',
      signal: new AbortController().signal,
      replan: () => {},
      newId: () => `run-${++ids}`,
    };
    return { db, ctx, sent };
  }

  it('builds the brief of the local day late in the evening, when utc is already the next day', async () => {
    const { db, ctx, sent } = context('2026-10-12T23:30:00-07:00');
    expect((await runBriefJob(ctx)).status).toBe('completed');
    expect(briefOfDay(db, '2026-10-12')).toBeDefined();
    expect(briefOfDay(db, '2026-10-13')).toBeUndefined();
    expect(sent[0]).toMatch(/^Brief for Mon 12 Oct\n/);
    expect(sent[0]).toMatch(/\/#\/today\/2026-10-12$/);
  });

  it('builds the brief of the new day just after midnight', async () => {
    const { db, ctx } = context('2026-10-13T00:01:00-07:00');
    await runBriefJob(ctx);
    expect(briefOfDay(db, '2026-10-13')).toBeDefined();
  });

  it('builds one brief when two starts come at once', async () => {
    const sent: string[] = [];
    const { db, ctx } = context('2026-10-12T07:30:00-07:00', sent);
    const today = createToday(ctx);
    const [first, second] = await Promise.all([today.runBrief(), today.runBrief()]);
    expect(first.status).toBe('completed');
    expect(second).toEqual({ status: 'skipped', error: 'the brief is already being built' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM briefs').get()?.n).toBe(1);
    expect(sent).toHaveLength(1);
    expect(today.running()).toBe(false);
    // after the first is done, a new start builds a second brief of the day, as a new row.
    expect((await today.runBrief()).status).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM briefs').get()?.n).toBe(2);
  });

  it('frees the guard when a brief fails', async () => {
    const { db, ctx } = context('2026-10-12T07:30:00-07:00');
    const today = createToday(ctx);
    db.exec('DROP TABLE brief_deliveries; DROP TABLE briefs');
    expect((await today.runBrief()).status).toBe('failed');
    expect(today.running()).toBe(false);
  });
});
