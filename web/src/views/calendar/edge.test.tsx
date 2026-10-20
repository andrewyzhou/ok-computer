// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarEvent, CalendarPage as CalendarData } from '../../../../src/dashboard/calendar-types';
import { CALENDAR_WEEK } from '../../../../test/fixtures/today-data';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, openApp, stubFetch } from '../../testing';
import { HIDDEN_KEY } from './parts';

// the edge cases of the calendar page: a dense day, an event that is not in the range, a long guest list, links that
// are not safe, cancelled events, a timed proposal, events across midnight and a reload after an approval.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  localStorage.removeItem(HIDDEN_KEY);
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

const pdt = (day: string, time: string) => new Date(`${day}T${time}:00-07:00`).toISOString();
const base = CALENDAR_WEEK.events.find((each) => each.eventId === 'office')!;

function event(id: string, fields: Partial<CalendarEvent>): CalendarEvent {
  return { ...base, key: `school/primary/${id}`, eventId: id, uid: id, ...fields };
}

const withEvents = (events: CalendarEvent[], extra: Partial<CalendarData> = {}): CalendarData => ({
  ...CALENDAR_WEEK,
  events: [...CALENDAR_WEEK.events, ...events].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.key.localeCompare(b.key)),
  ...extra,
});

const block = (key: string) => document.querySelector<HTMLElement>(`main [data-key="${CSS.escape(key)}"]`);
const details = () => within(document.querySelector('.details') as HTMLElement);

function open(page: CalendarData, hash = '#/calendar?day=2026-10-12') {
  const calls = stubFetch(seeded.dashboard, { 'GET /api/calendar': () => page });
  openApp(hash);
  return calls;
}

// five panels on wednesday that start within 20 minutes of each other.
const panels = ['a', 'b', 'c', 'd', 'e'].map((letter, index) =>
  event(`panel-${letter}`, {
    title: `Panel ${letter.toUpperCase()}`,
    startAt: pdt('2026-10-14', `13:${['00', '00', '10', '15', '20'][index]}`),
    endAt: pdt('2026-10-14', `14:${['00', '30', '00', '15', '00'][index]}`),
    startDay: '2026-10-14',
    endDay: '2026-10-14',
  }),
);

describe('a dense week', () => {
  it('keeps the week readable with a +n more block that opens the day with every panel', async () => {
    open(withEvents(panels));
    const more = await inMain().findByRole('button', { name: '+4 more' });
    expect(more.getAttribute('title')).toBe('Panel A, Panel C, Panel D, Panel E');
    expect(block('school/primary/panel-b')!.style.width).toBe('calc(50% - 3px)');
    expect(block('school/primary/panel-a')).toBeNull();
    fireEvent.click(more);
    await waitFor(() => expect(location.hash).toBe('#/calendar?day=2026-10-14&mode=day'));
    // the stub answers with the whole week, so the day grid still has seven columns here, and each panel shows.
    await waitFor(() => expect(block('school/primary/panel-a')).toBeTruthy());
    for (const panel of panels) expect(block(panel.key)).toBeTruthy();
    expect(inMain().queryByRole('button', { name: /more$/ })).toBeNull();
   }, 20_000);
});

describe('the details of an event', () => {
  it('says so when the selected event is not in the range', async () => {
    open(CALENDAR_WEEK, `#/calendar?day=2026-10-12&event=${encodeURIComponent('school/primary/gone')}`);
    expect(await details().findByText('This event is not in this week, or its calendar is hidden.')).toBeTruthy();
  });

  it('shows a long guest list as counts first', async () => {
    const guests = Array.from({ length: 12 }, (_, index) => ({
      name: `Guest ${index + 1}`,
      email: null,
      answer: index < 7 ? 'accepted' : index < 9 ? 'tentative' : 'needsAction',
      organizer: index === 0,
      optional: false,
      self: false,
    }));
    open(withEvents([event('big', { title: 'All hands', startAt: pdt('2026-10-16', '10:00'), endAt: pdt('2026-10-16', '11:00'), startDay: '2026-10-16', endDay: '2026-10-16', guests })]));
    await waitFor(() => expect(block('school/primary/big')).toBeTruthy());
    fireEvent.click(block('school/primary/big')!);
    const panel = details();
    expect(await panel.findByText('12 guests: 7 going, 2 maybe, 3 not answered')).toBeTruthy();
    expect(panel.queryByText('Guest 5')).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Show the guests' }));
    expect(panel.getByText('Guest 5')).toBeTruthy();
    expect(panel.getByText('Guest 1 · organizer')).toBeTruthy();
  });

  it('never links a video or a calendar link that is not safe', async () => {
    open(
      withEvents([
        event('odd', {
          title: 'Odd links',
          startAt: pdt('2026-10-16', '12:00'),
          endAt: pdt('2026-10-16', '13:00'),
          startDay: '2026-10-16',
          endDay: '2026-10-16',
          videoUrl: 'javascript:alert(1)',
          htmlLink: 'http://www.google.com/calendar/event?eid=odd',
        }),
      ]),
    );
    await waitFor(() => expect(block('school/primary/odd')).toBeTruthy());
    fireEvent.click(block('school/primary/odd')!);
    const panel = details();
    expect((await panel.findByText('javascript:alert(1)')).tagName).toBe('CODE');
    expect(panel.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();
    expect(panel.queryByRole('link', { name: /Open in Google Calendar/ })).toBeNull();
  });
});

describe('the items of the grid', () => {
  it('leaves out a cancelled event', async () => {
    open(withEvents([event('off', { title: 'Called off', status: 'cancelled', startAt: pdt('2026-10-16', '09:00'), endAt: pdt('2026-10-16', '10:00'), startDay: '2026-10-16', endDay: '2026-10-16' })]));
    await waitFor(() => expect(block('school/primary/advisor')).toBeTruthy());
    expect(block('school/primary/off')).toBeNull();
    expect(inMain().getByText('15 events · 2 to answer')).toBeTruthy();
  });

  it('draws a timed proposal with no end as a dashed half hour', async () => {
    open({
      ...CALENDAR_WEEK,
      proposals: [{ proposalId: 8, account: 'personal', title: 'Pay the rent', kind: 'bill', startAt: pdt('2026-10-16', '09:00'), endAt: null, allDay: false, approvalId: null }],
    });
    await waitFor(() => expect(block('proposal:8')).toBeTruthy());
    const proposal = block('proposal:8')!;
    expect(proposal.className).toContain('cal-block');
    expect(proposal.className).toContain('is-proposal');
    expect(proposal.closest('[data-day]')!.getAttribute('data-day')).toBe('2026-10-16');
    fireEvent.click(proposal);
    const panel = details();
    expect(await panel.findByText('Fri 16 Oct, 09:00 to 09:30')).toBeTruthy();
    expect(panel.queryByRole('article')).toBeNull();
  });

  it('draws an event across midnight on both days and a long one in the all-day row', async () => {
    open(
      withEvents([
        event('late', { title: 'Late shift', startAt: pdt('2026-10-16', '22:00'), endAt: pdt('2026-10-17', '02:00'), startDay: '2026-10-16', endDay: '2026-10-17' }),
        event('trip', { title: 'Trip', startAt: pdt('2026-10-17', '08:00'), endAt: pdt('2026-10-19', '20:00'), startDay: '2026-10-17', endDay: '2026-10-19' }),
      ]),
    );
    await waitFor(() => expect(document.querySelectorAll(`main [data-key="school/primary/late"]`)).toHaveLength(2));
    const days = [...document.querySelectorAll(`main [data-key="school/primary/late"]`)].map((each) => each.closest('[data-day]')!.getAttribute('data-day'));
    expect(days).toEqual(['2026-10-16', '2026-10-17']);
    const trip = block('school/primary/trip')!;
    expect(trip.className).toContain('cal-bar');
    expect(trip.className).toContain('to-after');
    expect(trip.style.gridColumn).toBe('6 / span 2');
    fireEvent.click(trip);
    expect(await details().findByText('Sat 17 Oct 08:00 to Mon 19 Oct 20:00')).toBeTruthy();
  });
});

describe('the reload of the calendar', () => {
  it('loads again when an approval changes, because an approved proposal becomes an event', async () => {
    const calls = open(CALENDAR_WEEK);
    await waitFor(() => expect(block('proposal:7')).toBeTruthy());
    const count = () => calls.filter((call) => call.url.startsWith('/api/calendar')).length;
    const before = count();
    FakeEventSource.find('/api/stream')!.emit({ kind: 'approval', id: 11, status: 'approved' });
    await waitFor(() => expect(count()).toBe(before + 1));
  });
});
