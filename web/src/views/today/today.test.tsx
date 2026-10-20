// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Brief } from '../../../../src/dashboard/brief-types';
import { BRIEF_FULL, BRIEF_QUIET, BRIEF_SCHEDULE, TODAY_NOW, TODAY_TZ } from '../../../../test/fixtures/today-data';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { calendarHash, sourceHash } from './links';

installEventSource();

beforeEach(() => setPrefs({ theme: 'system', devMode: false, detailsHidden: false }));
afterEach(() => cleanup());

const BRIEFS: Record<string, Brief> = { [BRIEF_FULL.day]: BRIEF_FULL, [BRIEF_QUIET.day]: BRIEF_QUIET };

// the routes of the today page on the fixture data. the other routes of the shell answer 404 from stubFetch.
function routes(extra: StubRoutes = {}): StubRoutes {
  return {
    'GET /api/meta': () => ({ timeZone: TODAY_TZ, now: TODAY_NOW }),
    'GET /api/brief/schedule': () => BRIEF_SCHEDULE,
    'GET /api/briefs/day/:day': ({ params }) => BRIEFS[params.day!] ?? json({ error: 'brief not found' }, 404),
    'GET /api/briefs': () => ({ briefs: [{ id: 2, day: BRIEF_FULL.day, createdAt: BRIEF_FULL.createdAt, items: 25, sent: true }], nextCursor: null }),
    ...extra,
  };
}

const details = () => within(document.querySelector('.details') as HTMLElement);

describe('the today page', () => {
  it('shows each section with its note and items, and links each item to its source', async () => {
    stubFetch(null, routes());
    openApp('#/today');
    const main = inMain();
    await main.findByText('Run with Sam');
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(main.getByText('Monday, October 12')).toBeTruthy();
    const titles = main.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual(BRIEF_FULL.content.sections.map((section) => section.title));
    expect(main.getByText('10 events, the next at 09:00.')).toBeTruthy();
    // the reply with a draft opens the draft, as the link of the digest item does.
    expect(within(main.getByRole('list', { name: 'Inbox' })).getByRole('link', { name: /Reply to Dana/ }).getAttribute('href')).toBe('#/inbox/drafts?id=5');
    expect(main.getByText('2 need a reply, 1 bill, 1 package.')).toBeTruthy();
    for (const section of BRIEF_FULL.content.sections) {
      const list = within(main.getByRole('list', { name: section.title }));
      const links = list.getAllByRole('link');
      expect(links.map((link) => link.getAttribute('href'))).toEqual(section.items.map((item) => sourceHash(item.source)));
      for (const [index, item] of section.items.entries()) {
        expect(within(links[index]!).getByText(item.title)).toBeTruthy();
        if (item.detail) expect(within(links[index]!).getByText(item.detail)).toBeTruthy();
        if (item.account) expect(within(links[index]!).getByText(item.account)).toBeTruthy();
      }
    }
    const conflict = within(main.getByRole('list', { name: 'Conflicts' })).getByRole('link');
    expect(conflict.className).toContain('today-tone-critical');
    expect(within(conflict).getByText('urgent')).toBeTruthy();
    expect(within(main.getByRole('list', { name: 'Tight moves' })).getByText('needs you')).toBeTruthy();
    expect(within(document.querySelector('.header-actions') as HTMLElement).getByRole('link', { name: 'Calendar' }).getAttribute('href')).toBe(calendarHash('2026-10-12'));
   }, 20_000);

  it('shows the schedule, the delivery and the message, and no sources strip when every source was read', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-12');
    const main = inMain();
    expect(await main.findByText('Brief at 07:30 each day · next Tue, Oct 13')).toBeTruthy();
    expect(await main.findByText('Sent to Telegram at 07:30')).toBeTruthy();
    fireEvent.click(main.getByText('Message'));
    expect(main.getByText(/Brief for Mon 12 Oct/).tagName).toBe('PRE');
    expect(main.queryByRole('list', { name: 'missing sources' })).toBeNull();
  });

  it('opens the details of an item on a click, with its source links', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-12');
    const main = inMain();
    const reading = within(await main.findByRole('list', { name: 'Schedule' })).getByText('Reading group').closest('a')!;
    fireEvent.click(reading);
    expect(reading.getAttribute('aria-current')).toBe('true');
    const panel = details();
    expect(await panel.findByText('16:00 to 17:00 · Moffitt 101 · not answered')).toBeTruthy();
    expect(panel.getByText('Mon 12 Oct, 16:00')).toBeTruthy();
    expect(panel.getByText('school')).toBeTruthy();
    expect(panel.getByText('calendar event')).toBeTruthy();
    expect(panel.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(calendarHash('2026-10-12', { mode: 'day', event: 'school/primary/reading' }));
    expect(panel.getByRole('link', { name: 'Day view' }).getAttribute('href')).toBe(calendarHash('2026-10-12', { mode: 'day' }));
    expect(location.hash).toBe('#/today/2026-10-12');
  });

  it('opens the details on enter, and a mail item has no day view', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-12');
    const item = (await inMain().findByText('Reply to Dana about the lease')).closest('a')!;
    fireEvent.keyDown(item, { key: 'Enter' });
    const panel = details();
    expect(await panel.findByText('A draft is in Gmail Drafts')).toBeTruthy();
    // the reply has a draft, so the item opens the draft.
    expect(panel.getByText('draft reply')).toBeTruthy();
    expect(panel.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('#/inbox/drafts?id=5');
    expect(panel.queryByRole('link', { name: 'Day view' })).toBeNull();
  });

  it('moves between days with the navigator, and loads the new day without a remount', async () => {
    const calls = stubFetch(null, routes());
    openApp('#/today/2026-10-12');
    const main = inMain();
    const first = await main.findByText('Run with Sam');
    const page = document.querySelector('.today-page');
    fireEvent.click(main.getByText('Lab meeting').closest('a')!);
    fireEvent.click(main.getByRole('button', { name: 'Previous day' }));
    await waitFor(() => expect(location.hash).toBe('#/today/2026-10-11'));
    expect(await main.findByRole('list', { name: 'missing sources' })).toBeTruthy();
    expect(first.isConnected).toBe(false);
    expect(document.querySelector('.today-page')).toBe(page);
    expect(main.getByText('Sunday, October 11')).toBeTruthy();
    expect(details().getByText('Select an item to see its details.')).toBeTruthy();
    expect(calls.filter((call) => call.url === '/api/briefs/day/2026-10-11')).toHaveLength(1);
    fireEvent.click(main.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(location.hash).toBe('#/today/2026-10-12'));
    expect(await main.findByText('Run with Sam')).toBeTruthy();
    fireEvent.click(main.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(location.hash).toBe('#/today/2026-10-13'));
    fireEvent.click(await main.findByRole('button', { name: 'Today' }));
    await waitFor(() => expect(location.hash).toBe('#/today/2026-10-12'));
    expect(document.querySelector('.today-page')).toBe(page);
  });

  it('shows a quiet day with the notes of its missing sources and a message that did not go out', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-11');
    const main = inMain();
    const strip = within(await main.findByRole('list', { name: 'missing sources' }));
    expect(main.queryByRole('list', { name: 'Schedule' })).toBeNull();
    expect(strip.getByText('Google is not set up, so the brief has no calendar.')).toBeTruthy();
    // the note of the day says the same as the strip, so it is not drawn twice, and the empty day section is left out.
    expect(main.getAllByText('Google is not set up, so the brief has no calendar.')).toHaveLength(1);
    expect(document.querySelector('.today-section')).toBeNull();
    expect(strip.getByRole('link', { name: 'Set up Google' }).getAttribute('href')).toBe('#/google');
    expect(strip.getByText('No inbox digest yet.')).toBeTruthy();
    expect(strip.getByRole('link', { name: 'Open the inbox' }).getAttribute('href')).toBe('#/inbox');
    expect(strip.queryByText(/desk|delegation/i)).toBeNull();
    expect(main.getByText('Not sent: no chat of the owner is known')).toBeTruthy();
  });

  it('names each calendar that could not be read', async () => {
    const partial: Brief = {
      ...BRIEF_FULL,
      content: { ...BRIEF_FULL.content, sources: { calendar: 'partial', skipped: [{ account: 'school', reason: 'Google did not answer for school.' }], digest: { id: 1, day: BRIEF_FULL.day }, desk: false } },
    };
    stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => partial }));
    openApp('#/today/2026-10-12');
    // the reason of each calendar shows in the same banner as on the calendar page, with the next step.
    const banner = await inMain().findByRole('status');
    const list = within(within(banner).getByRole('list', { name: 'missing calendars' }));
    expect(list.getAllByRole('listitem').map((each) => each.textContent)).toEqual(['Google did not answer for school.']);
    expect(within(banner).getByRole('link', { name: 'Open the Google page' }).getAttribute('href')).toBe('#/google');
    expect(inMain().queryByRole('list', { name: 'missing sources' })).toBeNull();
  });

  it('shows the first run with the time of the brief and a button that makes one now', async () => {
    const calls = stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => json({ error: 'brief not found' }, 404), 'GET /api/briefs': () => ({ briefs: [], nextCursor: null }), 'POST /api/brief/run': () => json({ started: true }, 202) }));
    openApp('#/today');
    const main = inMain();
    // the run of today at 07:30 is over, so the first brief comes tomorrow.
    expect(await main.findByText('Your first brief comes tomorrow at 07:30.')).toBeTruthy();
    expect(main.queryByRole('alert')).toBeNull();
    fireEvent.click(main.getByRole('button', { name: 'Make a brief now' }));
    expect(await main.findByText('Building the brief…')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/brief/run', body: {} });
  });

  it('says when the brief of a day comes when other briefs exist', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-13');
    expect(await inMain().findByText('The brief of Tuesday, October 13 comes at 07:30.')).toBeTruthy();
  });

  it('says that a past day has no brief', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-01');
    expect(await inMain().findByText('There is no brief for Thursday, October 1.')).toBeTruthy();
  });

  it('shows the schedule as off', async () => {
    stubFetch(null, routes({ 'GET /api/brief/schedule': () => ({ ...BRIEF_SCHEDULE, enabled: false, nextRunAt: null }) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    expect(await main.findByText('The brief is off')).toBeTruthy();
    expect(main.getByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(main.getByText('Run with Sam')).toBeTruthy();
  });

  it('shows an error with a try again that loads the brief again, and a button that makes a brief', async () => {
    let fail = true;
    stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => (fail ? json({ error: 'the brief row could not be read' }, 500) : BRIEF_FULL) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    const alert = await main.findByRole('alert');
    expect(alert.textContent).toContain('the brief row could not be read');
    expect(within(alert).getByRole('button', { name: 'Make a brief now' })).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await main.findByText('Run with Sam')).toBeTruthy();
    expect(main.queryByRole('alert')).toBeNull();
  });

  it('keeps the title today on a past day, with the day as the subtitle, and links to the latest brief', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-01');
    const main = inMain();
    expect(await main.findByText('There is no brief for Thursday, October 1.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(main.getByText('Thursday, October 1')).toBeTruthy();
    expect((await main.findByRole('link', { name: 'Open the latest brief' })).getAttribute('href')).toBe('#/today/2026-10-12');
  });

  it('says that the brief of today did not run when its time is over', async () => {
    stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => json({ error: 'brief not found' }, 404) }));
    openApp('#/today');
    const main = inMain();
    expect(await main.findByText('The brief of today did not run.')).toBeTruthy();
    expect(main.getByText('It was due at 07:30. Make one now, or wait for the next one tomorrow at 07:30.')).toBeTruthy();
    expect(main.getAllByRole('button', { name: 'Make a brief now' }).length).toBeGreaterThan(0);
  });

  it('shows a schedule that could not load as an error', async () => {
    stubFetch(null, routes({ 'GET /api/brief/schedule': () => json({ error: 'the schedule is gone' }, 500) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    const alert = await main.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the time of the brief: the schedule is gone');
    // the day bar stays, so the owner can still move between days.
    expect(main.getByRole('navigation', { name: 'days' })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await main.findByRole('alert')).toBeTruthy();
  });

  it('says at the top when the message did not reach the owner, with the page of the channel', async () => {
    stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => ({ ...BRIEF_FULL, delivery: { channel: 'telegram', ok: false, error: 'telegram answered 400', at: TODAY_NOW } }) }));
    openApp('#/today/2026-10-12');
    const alert = await inMain().findByRole('alert');
    expect(alert.textContent).toBe('The message of this brief did not reach you on Telegram: telegram answered 400.Check the channel on the Integrations page');
    expect(within(alert).getByRole('link').getAttribute('href')).toBe('#/integrations');
    // the banner comes before the first section.
    const first = inMain().getAllByRole('heading', { level: 2 })[0]!;
    expect(alert.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the first five items of a long section and the rest on a click, and the whole schedule', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `thread:personal:t${index}`,
      title: `mail ${index}`,
      detail: null,
      at: null,
      account: 'personal',
      tone: 'critical' as const,
      source: { kind: 'thread' as const, account: 'personal', threadId: `t${index}`, digestId: 1 },
    }));
    const long: Brief = {
      ...BRIEF_FULL,
      content: { ...BRIEF_FULL.content, sections: BRIEF_FULL.content.sections.map((section) => (section.kind === 'inbox' ? { ...section, items: many } : section)) },
    };
    stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => long }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    const inbox = await main.findByRole('list', { name: 'Inbox' });
    expect(within(inbox).getAllByRole('link')).toHaveLength(5);
    expect(within(main.getByRole('list', { name: 'Schedule' })).getAllByRole('link')).toHaveLength(10);
    fireEvent.click(main.getByRole('button', { name: 'Show 3 more' }));
    expect(within(main.getByRole('list', { name: 'Inbox' })).getAllByRole('link')).toHaveLength(8);
    expect(main.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
  });
});
