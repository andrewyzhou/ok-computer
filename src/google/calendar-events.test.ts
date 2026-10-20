import { describe, expect, it } from 'vitest';
import type { GoogleApis } from './accounts.js';
import { shownCalendars } from './calendar-events.js';

// apis whose calendar list gives these items, or fails when items is an error.
const apisWith = (items: unknown[] | Error) =>
  ({
    calendar: {
      calendarList: {
        list: async () => {
          if (items instanceof Error) throw items;
          return { data: { items } };
        },
      },
    },
  }) as unknown as GoogleApis;

describe('shownCalendars', () => {
  it('gives the primary color first and leaves out hidden and unselected calendars', async () => {
    const calendars = await shownCalendars(
      apisWith([
        { id: 'class@group.example', summary: 'CS 189', summaryOverride: 'class', selected: true, backgroundColor: '#16a765' },
        { id: 'hidden@group.example', summary: 'hidden', selected: true, hidden: true },
        { id: 'off@group.example', summary: 'off', selected: false },
        { id: 'me@example.com', summary: 'me@example.com', primary: true, selected: true, backgroundColor: '#9fe1e7' },
        { summary: 'no id', selected: true },
        { id: 'holidays@group.example', summary: 'Holidays', selected: true },
      ]),
    );
    expect(calendars).toEqual([
      { id: 'primary', label: null, color: '#9fe1e7', primary: true },
      { id: 'class@group.example', label: 'class', color: '#16a765', primary: false },
      { id: 'holidays@group.example', label: 'Holidays', color: null, primary: false },
    ]);
  });

  it('falls back to the primary calendar alone when the list fails', async () => {
    expect(await shownCalendars(apisWith(new Error('500')))).toEqual([{ id: 'primary', label: null, color: null, primary: true }]);
  });
});
