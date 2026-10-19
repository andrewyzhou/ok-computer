// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
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
