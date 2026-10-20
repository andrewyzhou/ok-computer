// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarPage as CalendarData } from '../../../../src/dashboard/calendar-types';
import { CALENDAR_EMPTY, CALENDAR_FAILED, CALENDAR_OFF, CALENDAR_WEEK, TODAY_EVENTS } from '../../../../test/fixtures/today-data';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRequest } from '../../testing';
import { addDays, daysFrom, zonedMidnight } from './grid';
import { clearPersonLookups } from '../people/PersonChip';
import { HIDDEN_KEY } from './parts';

// the calendar page on the fixture week of test/fixtures/today-data.ts. GET /api/calendar is stubbed with the
// fixtures, and the rest of the app comes from the seeded dashboard, whose clock is monday 2026-10-12 at 18:00.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  try {
    localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // a test below makes storage throw.
  }
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  installEventSource();
  await seeded.t.app.stop();
});

const WEEK = '#/calendar?day=2026-10-12';

// the page of the asked range, cut from a fixture: the days of the range, and the events and proposals that touch it.
function pageFor({ query }: StubRequest, base: CalendarData = CALENDAR_WEEK): CalendarData {
  const from = query.get('from') ?? base.from;
  const count = Number(query.get('days') ?? 7);
  const days = daysFrom(from, count);
  const start = zonedMidnight(from, base.timeZone);
  const end = zonedMidnight(addDays(from, count), base.timeZone);
  return {
    ...base,
    from,
    to: days.at(-1)!,
    days,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    events: base.events.filter((each) => Date.parse(each.startAt) < end && Date.parse(each.endAt) > start),
    proposals: base.proposals.filter((each) => each.startAt.slice(0, 10) >= from && each.startAt.slice(0, 10) <= days.at(-1)!),
  };
}

const calendarCalls = (calls: Array<{ url: string }>) => calls.filter((call) => call.url.startsWith('/api/calendar')).map((call) => call.url);

const block = (key: string) => document.querySelector<HTMLElement>(`main [data-key="${CSS.escape(key)}"]`);

async function openWeek(body: (request: StubRequest) => unknown = (request) => pageFor(request), hash = WEEK) {
  const calls = stubFetch(seeded.dashboard, { 'GET /api/calendar': body });
  openApp(hash);
  return calls;
}

async function fullWeek(hash = WEEK) {
  const calls = await openWeek(undefined, hash);
  await waitFor(() => expect(block('school/primary/advisor')).toBeTruthy());
  return calls;
}

const details = () => within(document.querySelector('.details') as HTMLElement);

describe('the calendar week', () => {
  it('draws a block for each event of the week, with the declined talk faded and the conflict on advisor and dentist', async () => {
    const calls = await fullWeek();
    expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-12&days=7');
    // the club social is one invitation on both accounts, so it is one block with the stripe of the second calendar.
    for (const event of TODAY_EVENTS) {
      if (event.key === 'school/primary/social-s') expect(block(event.key), event.key).toBeNull();
      else expect(block(event.key), event.key).toBeTruthy();
    }
    expect(block('personal/primary/social-p')!.className).toContain('has-copies');
    expect(block('personal/primary/social-p')!.title).toContain('also on school');
    expect(block('school/primary/talk')!.className).toContain('is-declined');
    expect(block('school/primary/reading')!.className).toContain('is-tentative');
    expect(block('personal/primary/focus')!.className).toContain('is-free');
    expect(block('personal/primary/birthday')!.className).toContain('cal-bar');
    expect(within(block('school/primary/advisor')!).getByRole('img', { name: 'Conflict' })).toBeTruthy();
    expect(within(block('personal/primary/dentist')!).getByRole('img', { name: 'Conflict' })).toBeTruthy();
    expect(within(block('school/primary/lab')!).queryByRole('img', { name: 'Conflict' })).toBeNull();
    expect(inMain().getByText('15 events · 2 to answer')).toBeTruthy();
    expect(inMain().getByRole('heading', { name: '12 – 18 Oct 2026' })).toBeTruthy();
    const legend = within(inMain().getByRole('group', { name: 'calendars' }));
    expect(legend.getAllByRole('button').map((each) => each.textContent)).toEqual(['personal', 'school', 'CS 189school']);
   }, 20_000);

  it('puts the tight move marker on the lecture, where the owner has to arrive', async () => {
    await fullWeek();
    const lecture = block('school/cs189@group.calendar.google.com/lecture')!;
    const marker = within(lecture).getByRole('img', { name: 'Tight move: 5 minutes from Soda Hall 510 to Wheeler 150' });
    expect(marker.dataset.from).toBe('school/primary/lab');
    expect(marker.dataset.to).toBe('school/cs189@group.calendar.google.com/lecture');
    expect(lecture.closest('[data-day]')!.getAttribute('data-day')).toBe('2026-10-12');
    expect(within(block('school/primary/lab')!).queryByRole('img', { name: /Tight move/ })).toBeNull();
    // the key under the legend explains the marks of the grid.
    const key = within(inMain().getByRole('list', { name: 'marks' }));
    expect(key.getAllByRole('listitem').map((each) => each.textContent)).toEqual(['Conflict', 'Tight move', 'Not answered or maybe', 'Proposed, waits for you', 'Declined']);
  });

  it('draws proposal 7 as a dashed all-day block on wednesday', async () => {
    await fullWeek();
    const proposal = block('proposal:7')!;
    expect(proposal.className).toContain('is-proposal');
    expect(proposal.textContent).toContain('Problem set 4 due');
    expect(proposal.textContent).toContain('Proposed');
    expect(proposal.style.gridColumn).toBe('3 / span 1');
  });

  it('selects an event into the hash and shows its details', async () => {
    await fullWeek();
    fireEvent.click(block('school/primary/advisor')!);
    await waitFor(() => expect(location.hash).toBe(`#/calendar?day=2026-10-12&event=${encodeURIComponent('school/primary/advisor')}`));
    const panel = details();
    expect(await panel.findByText('Conflicts with Dentist from 14:15 to 14:30.')).toBeTruthy();
    expect(panel.getByRole('heading', { name: 'Advisor 1:1' })).toBeTruthy();
    expect(panel.getByText('Mon 12 Oct, 14:00 to 14:30')).toBeTruthy();
    const video = panel.getByRole('link', { name: 'https://meet.google.com/abc-defg-hij' });
    expect(video.getAttribute('target')).toBe('_blank');
    expect(video.getAttribute('rel')).toContain('noopener');
    expect(panel.getByRole('link', { name: /Open in Google Calendar/ }).getAttribute('href')).toBe('https://www.google.com/calendar/event?eid=advisor');
    // a guest with an address shows as a person chip, and the organizer mark follows it.
    const guest = panel.getAllByText('advisor@school.example.edu').find((each) => each.closest('.cal-guests'))!.closest('li')!;
    expect(guest.querySelector('.person-chip')).toBeTruthy();
    expect(guest.querySelector('.cal-guest-marks')!.textContent).toBe('organizer');
    expect(block('school/primary/advisor')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('links a guest that the people memory knows to the profile through the person chip', async () => {
    clearPersonLookups();
    stubFetch(seeded.dashboard, {
      'GET /api/calendar': (request) => pageFor(request),
      'GET /api/people/lookup': ({ query }) =>
        query.get('email') === 'advisor@school.example.edu' ? { id: 7, name: 'Dana Advisor', displayName: 'Dana Advisor', primaryEmail: 'advisor@school.example.edu', organization: 'School' } : json({ error: 'person not found' }, 404),
    });
    openApp(`${WEEK}&event=${encodeURIComponent('school/primary/advisor')}`);
    const chip = await details().findByRole('link', { name: 'Open Dana Advisor' });
    expect(chip.getAttribute('href')).toBe('#/people/7');
    clearPersonLookups();
  });

  it('shows the travel note, the repeat and the notes of the lecture', async () => {
    await fullWeek(`${WEEK}&event=${encodeURIComponent('school/cs189@group.calendar.google.com/lecture')}`);
    const panel = details();
    expect(await panel.findByText('Tight move: 5 minutes to get from Soda Hall 510 (Lab meeting) to Wheeler 150.')).toBeTruthy();
    expect(panel.getByText('This event is one of a series.')).toBeTruthy();
    expect(panel.getByText('Lecture 12: kernels.')).toBeTruthy();
    expect(panel.getByText('cs189-staff@school.example.edu')).toBeTruthy();
  });

  it('shows a hostile title as text', async () => {
    const hostile = '<img src=x onerror="window.hacked=1">';
    const week: CalendarData = { ...CALENDAR_WEEK, events: CALENDAR_WEEK.events.map((each) => (each.eventId === 'lab' ? { ...each, title: hostile, notes: '<b>bold</b>' } : each)) };
    await openWeek(() => week);
    await waitFor(() => expect(block('school/primary/lab')).toBeTruthy());
    expect(within(block('school/primary/lab')!).getByText(hostile)).toBeTruthy();
    fireEvent.click(block('school/primary/lab')!);
    expect(await details().findByText('<b>bold</b>')).toBeTruthy();
    expect(document.querySelector('main img, .details img, .details b')).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  it('opens a proposal with its link and its approval card', async () => {
    const week: CalendarData = { ...CALENDAR_WEEK, proposals: CALENDAR_WEEK.proposals.map((each) => ({ ...each, approvalId: seeded.pendingApprovalId })) };
    const calls = await openWeek(() => week);
    await waitFor(() => expect(block('proposal:7')).toBeTruthy());
    fireEvent.click(block('proposal:7')!);
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-12&event=proposal%3A7'));
    const panel = details();
    expect((await panel.findByRole('link', { name: 'Open proposal #7' })).getAttribute('href')).toBe('#/inbox/proposals?id=7');
    expect(panel.getByText('course')).toBeTruthy();
    expect(panel.getByText('Wed 14 Oct, all day')).toBeTruthy();
    const card = await panel.findByRole('article', { name: `approval #${seeded.pendingApprovalId}` });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: `/api/approvals/${seeded.pendingApprovalId}`, body: { decision: 'approve' } }));
  });

  it('closes the details and clears the event from the hash', async () => {
    await fullWeek(`${WEEK}&event=${encodeURIComponent('school/primary/lab')}`);
    await details().findByText('Soda Hall 510');
    fireEvent.click(details().getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(location.hash).toBe(WEEK));
  });
});

describe('the calendar legend', () => {
  it('hides a calendar and keeps the choice in localStorage', async () => {
    await fullWeek();
    const chip = inMain().getByRole('button', { name: 'personal' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    await waitFor(() => expect(block('personal/primary/dentist')).toBeNull());
    expect(block('school/primary/advisor')).toBeTruthy();
    expect(within(block('school/primary/advisor')!).getByRole('img', { name: 'Conflict' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['personal/primary']);
    expect(inMain().getByText('8 events · 2 to answer')).toBeTruthy();
    cleanup();
    await fullWeek();
    expect(block('personal/primary/dentist')).toBeNull();
    fireEvent.click(inMain().getByRole('button', { name: 'personal' }));
    await waitFor(() => expect(block('personal/primary/dentist')).toBeTruthy());
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual([]);
  });

  it('still works when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    await fullWeek();
    fireEvent.click(inMain().getByRole('button', { name: 'school' }));
    await waitFor(() => expect(block('school/primary/advisor')).toBeNull());
    expect(block('personal/primary/dentist')).toBeTruthy();
  });

  it('ignores a stored value that is not a list of keys', async () => {
    localStorage.setItem(HIDDEN_KEY, '{"oops":1}');
    await fullWeek();
    expect(block('personal/primary/dentist')).toBeTruthy();
  });
});

describe('the calendar range', () => {
  it('moves by a week with previous and next', async () => {
    const calls = await fullWeek();
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-05'));
    await waitFor(() => expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-05&days=7'));
    expect(await inMain().findByRole('heading', { name: '5 – 11 Oct 2026' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-12'));
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-19&days=7'));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(location.hash).toBe('#/calendar'));
    expect(await inMain().findByRole('heading', { name: '12 – 18 Oct 2026' })).toBeTruthy();
  });

  it('fetches days=1 in day mode and moves by a day', async () => {
    const calls = await openWeek(undefined, '#/calendar?day=2026-10-14&mode=day');
    await waitFor(() => expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-14&days=1'));
    expect(await inMain().findByRole('heading', { name: 'Wed 14 Oct 2026' })).toBeTruthy();
    await waitFor(() => expect(block('proposal:7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-15&days=1'));
    await waitFor(() => expect(block('personal/primary/dinner')).toBeTruthy());
    expect(block('school/cs189@group.calendar.google.com/hw3')).toBeTruthy();
  });

  it('switches between week and day with the segmented control', async () => {
    const calls = await fullWeek('#/calendar?day=2026-10-14');
    expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-12&days=7');
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-14&mode=day'));
    await waitFor(() => expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-14&days=1'));
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-14'));
  });

  it('opens a day from its heading in the week', async () => {
    await fullWeek();
    fireEvent.click(inMain().getByRole('button', { name: 'Thu 15' }));
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-15&mode=day'));
  });

  it('reads today from the server and falls back to it for a bad day', async () => {
    const calls = await openWeek(undefined, '#/calendar?day=2026-02-30');
    await waitFor(() => expect(calendarCalls(calls)).toContain('/api/calendar?from=2026-10-12&days=7'));
    await waitFor(() => expect(block('school/primary/advisor')).toBeTruthy());
    expect(inMain().getByRole('img', { name: /^now, / })).toBeTruthy();
  });
});

describe('the calendar states', () => {
  it('shows a skeleton while the calendar loads', async () => {
    await openWeek(() => new Promise(() => {}));
    expect(await inMain().findByText('Loading the calendar…')).toBeTruthy();
  });

  it('says so when the week is empty', async () => {
    await openWeek((request) => pageFor(request, CALENDAR_EMPTY));
    expect(await inMain().findByText('Nothing on the calendar this week.')).toBeTruthy();
    expect(inMain().getByText('No events')).toBeTruthy();
    expect(inMain().getByRole('group', { name: 'calendars' })).toBeTruthy();
  });

  it('asks to connect google on a first run', async () => {
    await openWeek(() => CALENDAR_OFF);
    expect(await inMain().findByText('Connect Google to see your calendars')).toBeTruthy();
    const google = inMain().getByRole('link', { name: 'Open the Google page' });
    expect(google.getAttribute('href')).toBe('#/google');
    // the one next step of a first run is the main action.
    expect(google.className).toContain('btn-primary');
    expect(screen.queryByRole('button', { name: 'Previous week' })).toBeNull();
  });

  it('lists each reason when every account failed, and retries', async () => {
    const calls = await openWeek(() => CALENDAR_FAILED);
    const alert = within(await inMain().findByRole('alert'));
    expect(alert.getByText('Could not read any calendar.')).toBeTruthy();
    expect(alert.getByText('personal needs a new sign-in on the Google page.')).toBeTruthy();
    expect(alert.getByText('Google did not answer for school.')).toBeTruthy();
    const before = calendarCalls(calls).length;
    fireEvent.click(alert.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calendarCalls(calls).length).toBe(before + 1));
  });

  it('shows a banner above the grid when one account failed', async () => {
    const partial: CalendarData = {
      ...CALENDAR_WEEK,
      calendars: CALENDAR_WEEK.calendars.filter((each) => each.account === 'personal'),
      events: CALENDAR_WEEK.events.filter((each) => each.account === 'personal'),
      conflicts: [],
      travelGaps: [],
      invites: ['personal/primary/dinner'],
      skipped: [{ account: 'school', reason: 'school needs a new sign-in on the Google page.' }],
    };
    await openWeek(() => partial);
    const banner = await inMain().findByRole('status');
    expect(within(banner).getByText('school needs a new sign-in on the Google page.')).toBeTruthy();
    expect(within(banner).getByRole('link', { name: 'Open the Google page' }).getAttribute('href')).toBe('#/google');
    await waitFor(() => expect(block('personal/primary/dentist')).toBeTruthy());
    expect(block('school/primary/advisor')).toBeNull();
    expect(inMain().getByText('7 events · 1 to answer')).toBeTruthy();
  });

  it('shows the text of a 400 and of a 500', async () => {
    await openWeek(() => json({ error: 'from must be a day' }, 400));
    expect(await inMain().findByText('Could not load the calendar: from must be a day')).toBeTruthy();
    cleanup();
    let fail = true;
    const calls = await openWeek((request) => (fail ? json({ error: 'the calendar failed' }, 500) : pageFor(request)));
    expect(await inMain().findByText('Could not load the calendar: the calendar failed')).toBeTruthy();
    fail = false;
    fireEvent.click(inMain().getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(block('school/primary/advisor')).toBeTruthy());
    expect(calendarCalls(calls).length).toBe(2);
  });
});

describe('the calendar agenda', () => {
  // the shell and the page ask matchMedia for a max width. 390 pixels is narrower than each of them.
  function narrow() {
    vi.stubGlobal('matchMedia', (text: string) => ({
      matches: Number(/max-width: ([\d.]+)px/.exec(text)?.[1] ?? 0) >= 390,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  it('lists the days with their items and badges instead of the grid', async () => {
    narrow();
    await openWeek();
    const agenda = within(await inMain().findByRole('region', { name: 'agenda' }));
    expect(inMain().queryByRole('region', { name: 'week' })).toBeNull();
    const monday = within(agenda.getByRole('region', { name: 'Mon 12 Oct' }));
    expect(monday.getByRole('heading', { name: /Mon 12 Oct/ })).toBeTruthy();
    const rows = monday.getAllByRole('button');
    expect(rows[0]!.textContent).toContain('All day');
    expect(rows[0]!.textContent).toContain("Mom's birthday");
    expect(rows[1]!.textContent).toContain('07:00–07:45');
    const row = (key: string) => within(block(key)!);
    expect(row('school/primary/advisor').getByText('Conflict')).toBeTruthy();
    expect(row('personal/primary/dentist').getByText('Conflict')).toBeTruthy();
    expect(row('school/cs189@group.calendar.google.com/lecture').getByText('Tight move')).toBeTruthy();
    expect(row('school/primary/reading').getByText('Not answered')).toBeTruthy();
    expect(row('proposal:7').getByText('Proposed')).toBeTruthy();
    expect(within(agenda.getByRole('region', { name: 'Sat 17 Oct' })).getByText('Nothing planned.')).toBeTruthy();
    fireEvent.click(block('school/primary/reading')!);
    await waitFor(() => expect(location.hash).toContain(`event=${encodeURIComponent('school/primary/reading')}`));
    expect(await details().findByText('We read chapter 4.')).toBeTruthy();
  });

  it('shows one day in day mode', async () => {
    narrow();
    await openWeek(undefined, '#/calendar?day=2026-10-15&mode=day');
    const agenda = within(await inMain().findByRole('region', { name: 'agenda' }));
    expect(agenda.getAllByRole('heading').map((each) => each.textContent)).toEqual(['Thu 15 Oct']);
    expect(within(block('personal/primary/dinner')!).getByText('Not answered')).toBeTruthy();
  });
});

describe('the details of an event and of a proposal', () => {
  it('shows the whole title in the body, and both calendars of one invitation on two accounts', async () => {
    await fullWeek(`${WEEK}&event=${encodeURIComponent('school/primary/social-s')}`);
    const panel = details();
    // the link of the second copy opens the one block of the invitation.
    expect(await panel.findByRole('heading', { name: 'Club social', level: 3 })).toBeTruthy();
    expect(panel.getByRole('heading', { name: 'Event', level: 2 })).toBeTruthy();
    expect(panel.getByText('Calendars')).toBeTruthy();
    expect(panel.getByText('personal')).toBeTruthy();
    expect(panel.getByText('school')).toBeTruthy();
    expect(block('personal/primary/social-p')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('names a proposal in the header and shows its whole title in the body', async () => {
    await fullWeek(`${WEEK}&event=proposal%3A7`);
    const panel = details();
    expect(await panel.findByRole('heading', { name: 'Problem set 4 due', level: 3 })).toBeTruthy();
    expect(panel.getByRole('heading', { name: 'Proposal', level: 2 })).toBeTruthy();
  });

  it('points to google calendar for notes that were cut', async () => {
    const long = { ...CALENDAR_WEEK.events.find((each) => each.eventId === 'advisor')!, notes: `${'word '.repeat(90).trim()}…` };
    await openWeek((request) => pageFor(request, { ...CALENDAR_WEEK, events: CALENDAR_WEEK.events.map((each) => (each.key === long.key ? long : each)) }), `${WEEK}&event=${encodeURIComponent(long.key)}`);
    expect(await details().findByText('The notes go on in Google Calendar.')).toBeTruthy();
  });
});
