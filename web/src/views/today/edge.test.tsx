// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brief, BriefSchedule } from '../../../../src/dashboard/brief-types';
import { BRIEF_FULL, BRIEF_QUIET, BRIEF_SCHEDULE, TODAY_NOW, TODAY_TZ } from '../../../../test/fixtures/today-data';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';

installEventSource();

beforeEach(() => setPrefs({ theme: 'system', devMode: false, detailsHidden: false }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const HOSTILE = '<img src=x onerror=alert(1)>';

function routes(extra: StubRoutes = {}): StubRoutes {
  return {
    'GET /api/meta': () => ({ timeZone: TODAY_TZ, now: TODAY_NOW }),
    'GET /api/brief/schedule': () => BRIEF_SCHEDULE,
    'GET /api/briefs/day/:day': ({ params }) => (params.day === BRIEF_QUIET.day ? BRIEF_QUIET : params.day === BRIEF_FULL.day ? BRIEF_FULL : json({ error: 'brief not found' }, 404)),
    'GET /api/briefs': () => ({ briefs: [], nextCursor: null }),
    ...extra,
  };
}

// a brief of the day with one item, the newer row of the day.
const NEWER: Brief = {
  ...BRIEF_FULL,
  id: 3,
  content: { ...BRIEF_FULL.content, sections: [{ kind: 'goals', title: 'Goals', note: null, items: [{ id: 'goal:9', title: 'call the bank', detail: null, at: null, account: null, tone: null, source: { kind: 'goal', goalId: 9 } }] }] },
};

describe('the today page at its edges', () => {
  it('shows a hostile title and detail as text', async () => {
    const hostile: Brief = {
      ...BRIEF_FULL,
      shortText: `Brief\n${HOSTILE}`,
      content: {
        ...BRIEF_FULL.content,
        sections: [{ kind: 'inbox', title: 'Inbox', note: HOSTILE, items: [{ id: 'thread:x', title: HOSTILE, detail: `<b>${HOSTILE}</b>`, at: null, account: 'personal', tone: 'warning', source: { kind: 'thread', account: 'personal', threadId: 'x', digestId: 1 } }] }],
      },
    };
    stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => hostile }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    const link = (await main.findAllByText(HOSTILE)).find((each) => each.className === 'today-item-title')!.closest('a')!;
    expect(link.getAttribute('href')).toBe('#/inbox/digests/1');
    expect(within(link).getByText(`<b>${HOSTILE}</b>`)).toBeTruthy();
    fireEvent.click(link);
    await waitFor(() => expect(document.querySelectorAll('.today-details-title')).toHaveLength(1));
    expect(document.querySelector('.today-details-title')!.textContent).toBe(HOSTILE);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('makes a brief now and shows it when the stream sends a run message', async () => {
    let brief: Brief | Response = json({ error: 'brief not found' }, 404);
    const calls = stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => brief, 'POST /api/brief/run': () => json({ started: true }, 202) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    fireEvent.click(await main.findByRole('button', { name: 'Make a brief now' }));
    expect(await main.findByText('Building the brief…')).toBeTruthy();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', url: '/api/brief/run', body: {} }]);
    brief = NEWER;
    act(() => FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-brief-3', status: 'completed' } }));
    expect(await main.findByText('call the bank')).toBeTruthy();
    await waitFor(() => expect(main.queryByText('Building the brief…')).toBeNull());
  });

  it('asks again every 3 seconds after a start, and stops when the new brief is there', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    let brief: Brief = BRIEF_FULL;
    const calls = stubFetch(null, routes({ 'GET /api/briefs/day/:day': () => brief, 'POST /api/brief/run': () => json({ started: true }, 202) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    await main.findByText('Run with Sam');
    const button = document.querySelector('.header-actions button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(await main.findByText('Building the brief…')).toBeTruthy();
    const asked = () => calls.filter((call) => call.url === '/api/briefs/day/2026-10-12').length;
    const before = asked();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(asked()).toBe(before + 1));
    expect(main.getByText('Building the brief…')).toBeTruthy();
    brief = NEWER;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await main.findByText('call the bank')).toBeTruthy();
    await waitFor(() => expect(main.queryByText('Building the brief…')).toBeNull());
    const after = asked();
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(asked()).toBe(after);
  });

  it('gives up after 10 tries and says that the brief is not ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    stubFetch(null, routes({ 'POST /api/brief/run': () => json({ started: true }, 202) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    await main.findByText('Run with Sam');
    fireEvent.click(document.querySelector('.header-actions button') as HTMLButtonElement);
    await main.findByText('Building the brief…');
    for (let i = 0; i < 10; i++) await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await main.findByText('The brief is not ready yet. It shows here when it is.')).toBeTruthy();
  });

  it('shows the text of a 409 when a brief builds already', async () => {
    stubFetch(null, routes({ 'POST /api/brief/run': () => json({ error: 'a brief is being built' }, 409) }));
    openApp('#/today/2026-10-12');
    const main = inMain();
    await main.findByText('Run with Sam');
    fireEvent.click(document.querySelector('.header-actions button') as HTMLButtonElement);
    expect((await main.findByRole('alert')).textContent).toBe('a brief is being built');
    expect(main.queryByText('Building the brief…')).toBeNull();
  });

  it('starts a brief from another day and goes to today', async () => {
    stubFetch(null, routes({ 'POST /api/brief/run': () => json({ started: true }, 202) }));
    openApp('#/today/2026-10-11');
    const main = inMain();
    await main.findByRole('list', { name: 'missing sources' });
    fireEvent.click(document.querySelector('.header-actions button') as HTMLButtonElement);
    await waitFor(() => expect(location.hash).toBe('#/today/2026-10-12'));
    expect(await main.findByText('Run with Sam')).toBeTruthy();
    // the brief of today is still the old row, so the new one is not there yet.
    expect(main.getByText('Building the brief…')).toBeTruthy();
  });

  it('moves the brief with the change control, and shows the text of a 400', async () => {
    let schedule: BriefSchedule = BRIEF_SCHEDULE;
    const calls = stubFetch(
      null,
      routes({
        'GET /api/brief/schedule': () => schedule,
        'PUT /api/brief/schedule': ({ body }) => {
          const time = (body as { time: string }).time;
          if (time === '06:00') return json({ error: 'time must be HH:MM, 00:00 to 23:59' }, 400);
          schedule = { ...schedule, time, nextRunAt: '2026-10-13T15:00:00.000Z' };
          return schedule;
        },
      }),
    );
    openApp('#/today/2026-10-12');
    const main = inMain();
    fireEvent.click(await main.findByRole('button', { name: 'Change' }));
    const input = main.getByLabelText('Time of the brief') as HTMLInputElement;
    expect(input.value).toBe('07:30');
    // the stub refuses 06:00, so the page shows the text of the 400 as the server words it.
    fireEvent.change(input, { target: { value: '06:00' } });
    fireEvent.click(main.getByRole('button', { name: 'Save' }));
    expect((await main.findByRole('alert')).textContent).toBe('time must be HH:MM, 00:00 to 23:59');
    fireEvent.change(input, { target: { value: '08:00' } });
    fireEvent.click(main.getByRole('button', { name: 'Save' }));
    expect(await main.findByText('Brief at 08:00 each day · next Tue 13 Oct')).toBeTruthy();
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ time: '06:00' }, { time: '08:00' }]);
    expect(main.queryByLabelText('Time of the brief')).toBeNull();
  });

  it('turns an off brief on with the same control', async () => {
    let schedule: BriefSchedule = { ...BRIEF_SCHEDULE, enabled: false, nextRunAt: null };
    stubFetch(null, routes({ 'GET /api/brief/schedule': () => schedule, 'PUT /api/brief/schedule': ({ body }) => (schedule = { ...BRIEF_SCHEDULE, ...(body as object) }) }));
    openApp('#/today/2026-10-13');
    const main = inMain();
    expect(await main.findByText('The brief is off.')).toBeTruthy();
    fireEvent.click(main.getByRole('button', { name: 'Turn on' }));
    fireEvent.click(main.getByRole('button', { name: 'Save' }));
    expect(await main.findByText('Brief at 07:30 each day · next Tue 13 Oct')).toBeTruthy();
  });

  it('says that a hash with a bad day is not a day, and asks the server nothing for it', async () => {
    const calls = stubFetch(null, routes());
    openApp('#/today/2026-02-30');
    expect(await inMain().findByText('This is not a day of the calendar.')).toBeTruthy();
    expect(calls.some((call) => call.url.startsWith('/api/briefs/day/'))).toBe(false);
  });

  it('closes the details and clears the selection', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-12');
    const main = inMain();
    const item = (await main.findByText('Dentist')).closest('a')!;
    fireEvent.click(item);
    const panel = within(document.querySelector('.details') as HTMLElement);
    await panel.findByText('14:15 to 15:00 · 2650 Telegraph Ave');
    fireEvent.click(panel.getByRole('button', { name: 'Close details' }));
    expect(await panel.findByText('Select an item to see its details.')).toBeTruthy();
    expect(item.getAttribute('aria-current')).toBeNull();
  });

  it('keeps the link for a click that opens a new tab', async () => {
    stubFetch(null, routes());
    openApp('#/today/2026-10-12');
    const item = (await inMain().findByText('Dentist')).closest('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    item.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(item.getAttribute('aria-current')).toBeNull();
  });
});
