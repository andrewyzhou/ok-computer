// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { seedDashboard } from '../../../test/seed';
import { inMain, installEventSource, openApp, stubFetch } from '../testing';
import { setPrefs } from './prefs';

// a hash that a person types or cuts short must never crash the shell.

installEventSource();

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  stubFetch((await seedDashboard()).dashboard);
});

afterEach(() => cleanup());

it('shows the missing page for a hash with bad percent-encoding', async () => {
  openApp('#/runs/%E0%A4%A');
  expect(await inMain().findByText('This page does not exist.')).toBeTruthy();
});

// the home page is the today page, so each empty form of the hash, a trailing slash and a day that is not a date all
// open it. the today page itself handles a bad day.
it.each(['', '#', '#/', '#/today', '#/today/', '#/today/not-a-day'])('opens the today page for the hash %j', async (hash) => {
  openApp(hash);
  expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
  expect(inMain().queryByText('This page does not exist.')).toBeNull();
});
