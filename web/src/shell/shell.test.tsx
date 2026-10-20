// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../test/seed';
import { ROUTES } from '../routes';
import { inMain, installEventSource, openApp, stubFetch } from '../testing';
import { CommandMenu } from './CommandMenu';
import type { CommandSource } from './extensions';
import { setPrefs } from './prefs';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
  stubFetch(seeded.dashboard);
});
afterEach(() => cleanup());

const nav = () => within(screen.getByRole('navigation', { name: 'pages' }));

describe('the shell', () => {
  it('opens the today page at the home hash and marks today in the nav and the rail', async () => {
    openApp('#/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(nav().getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
    expect(nav().getByRole('link', { name: 'Today' }).getAttribute('href')).toBe('#/today');
    expect(nav().getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
    const rail = within(screen.getByRole('navigation', { name: 'sections' }));
    expect(rail.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('true');
    expect(rail.getByRole('link', { name: 'ok computer, today' }).getAttribute('href')).toBe('#/');
    expect(nav().getByRole('link', { name: 'ok computer' }).getAttribute('href')).toBe('#/');
  });

  it('marks today in the nav for the page of a day', async () => {
    openApp('#/today/2026-10-19');
    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(nav().getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the overview with its stats, goals, heartbeat and next automations under agent', async () => {
    openApp('#/overview');
    expect(await inMain().findByText('Cost today')).toBeTruthy();
    expect(inMain().getByText('check-in: finish essay')).toBeTruthy();
    expect(inMain().getByText('Blob store')).toBeTruthy();
    expect(inMain().getByText('remind me when a goal eta is less than one hour away')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(nav().getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(nav().getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBeNull();
    const rail = within(screen.getByRole('navigation', { name: 'sections' }));
    expect(rail.getByRole('link', { name: 'Agent' }).getAttribute('aria-current')).toBe('true');
  });

  it('builds the nav from the routes, marks the current page and hides the dev pages until developer mode', async () => {
    openApp('#/cost');
    expect(await inMain().findByText('Cost by day')).toBeTruthy();
    const groups = nav()
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    // the hash opens a dev page outside developer mode, but the nav and the rail do not list it.
    expect(groups).toEqual(['Today', 'Inbox', 'Calendar', 'Chats', 'Activity', 'Agent', 'Connections']);
    expect(nav().queryByRole('link', { name: 'Cost' })).toBeNull();
    const rail = within(screen.getByRole('navigation', { name: 'sections' }));
    expect(rail.queryByRole('link', { name: 'Dev' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Developer mode' }));
    const devGroups = nav()
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(devGroups).toEqual(['Today', 'Inbox', 'Calendar', 'Chats', 'Activity', 'Agent', 'Connections', 'Dev']);
    expect(nav().getByRole('link', { name: 'Cost' }).getAttribute('aria-current')).toBe('page');
    expect(rail.getByRole('link', { name: 'Dev' }).getAttribute('aria-current')).toBe('true');
    fireEvent.change(nav().getByRole('searchbox'), { target: { value: 'goa' } });
    // the chats panel of the nav filters the chats of the real /api/chats too, and the main chat of the seed talks
    // about goals, so only the links of the pages are compared here.
    const pages = nav()
      .getAllByRole('link')
      .filter((link) => !(link.getAttribute('href') ?? '').startsWith('#/chats/'))
      .map((link) => link.textContent);
    expect(pages).toEqual(['ok computer', 'Goals']);
  });

  it('shows the breadcrumb of a detail page with a link to its list', async () => {
    openApp('#/runs/run-1');
    expect(await inMain().findByText('Timeline')).toBeTruthy();
    const crumbs = within(screen.getByRole('navigation', { name: 'breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Dev' }).getAttribute('href')).toBe('#/runs');
    expect(crumbs.getByRole('link', { name: 'Runs' }).getAttribute('href')).toBe('#/runs');
  });

  it('opens the command menu with the keyboard and goes to the chosen page', async () => {
    setPrefs({ devMode: true });
    openApp('#/overview');
    await inMain().findByText('Cost today');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    const input = within(menu).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'cost' } });
    expect(within(menu).getAllByRole('option')[0]!.textContent).toContain('Cost');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#/cost'));
    expect(screen.queryByRole('dialog', { name: 'Command menu' })).toBeNull();
  });

  it('lists the today, calendar and overview pages in the command menu', async () => {
    openApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    const options = within(menu)
      .getAllByRole('option')
      .map((option) => option.textContent ?? '');
    for (const label of ['Today', 'Calendar', 'Overview']) expect(options.some((text) => text.includes(label)), label).toBe(true);
    fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'overview' } });
    fireEvent.keyDown(within(menu).getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#/overview'));
  });

  it('turns developer mode on with the keyboard and the status bar, and keeps it in local storage', async () => {
    openApp('#/overview');
    await inMain().findByText('Cost today');
    const toggle = screen.getByRole('button', { name: 'Developer mode' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(window, { key: '.', metaKey: true });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toBe('DEV');
    expect(JSON.parse(localStorage.getItem('okc.prefs')!).devMode).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('changes the theme from the status bar', async () => {
    openApp('#/overview');
    await inMain().findByText('Cost today');
    const theme = () => screen.getByRole('button', { name: /^Theme:/ });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.click(theme());
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(theme());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(theme().getAttribute('aria-label')).toContain('dark theme');
  });

  it('counts the pending approvals and the cost of today in the status bar', async () => {
    openApp('#/');
    const bar = within(screen.getByRole('contentinfo', { name: 'status bar' }));
    await waitFor(() => expect(bar.getByRole('link', { name: /waiting for approval/ }).textContent).toMatch(/^1 waiting for approval/));
    expect(bar.getByText(/\$\d.* today/)).toBeTruthy();
    expect(bar.getByText('connecting')).toBeTruthy();
  });

  it('shows the selected row of a list in the details panel', async () => {
    openApp('#/overview');
    const name = await inMain().findByText('check-in: finish essay');
    const details = within(screen.getByRole('complementary', { name: 'details' }));
    expect(details.getByRole('heading', { name: 'Today' })).toBeTruthy();
    fireEvent.click(name.closest('tr')!);
    expect(details.getByRole('heading', { name: 'check-in: finish essay' })).toBeTruthy();
    expect(details.getByRole('link', { name: /Open in Automations/ })).toBeTruthy();
    fireEvent.click(details.getByRole('button', { name: 'Close details' }));
    expect(details.getByRole('heading', { name: 'Today' })).toBeTruthy();
  });

  it('says when a page does not exist', async () => {
    openApp('#/nowhere');
    expect(await inMain().findByText('This page does not exist.')).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'Go to today' }).getAttribute('href')).toBe('#/');
  });
});

describe('the command menu', () => {
  it('groups the hits of a source after the pages and aborts the request of an older text', async () => {
    const asked: string[] = [];
    const aborted: string[] = [];
    const source: CommandSource = {
      id: 'test',
      label: 'Test',
      minQuery: 2,
      search: (query, signal) => {
        asked.push(query);
        signal.addEventListener('abort', () => aborted.push(query));
        return Promise.resolve([
          {
            id: 'messages',
            label: 'Messages',
            items: [{ id: 'm1', label: 'essay plan', detail: { text: 'the essay is due', marks: [[4, 9]] }, href: 'chats/main@0' }],
            more: { label: 'All results', href: `search?q=${query}` },
          },
        ]);
      },
    };
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[source]} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'e' } });
    fireEvent.change(input, { target: { value: 'es' } });
    fireEvent.change(input, { target: { value: 'ess' } });
    expect(await screen.findByRole('group', { name: 'Messages' })).toBeTruthy();
    expect(asked).toEqual(['ess']);
    expect(screen.getByText('essay', { selector: 'mark' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /All results/ })).toBeTruthy();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'essa' } });
    });
    await waitFor(() => expect(asked).toEqual(['ess', 'essa']));
    expect(aborted).toContain('ess');
  });
});
