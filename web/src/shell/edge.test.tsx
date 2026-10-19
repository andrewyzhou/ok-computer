// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDashboard } from '../../../test/seed';
import { ROUTES } from '../routes';
import { inMain, installEventSource, openApp, stubFetch } from '../testing';
import { CommandMenu } from './CommandMenu';
import type { CommandSource } from './extensions';
import { setPrefs } from './prefs';

// the edge cases of the shell: the keys on each platform, a source that fails or answers late, the dev pages in the
// command menu, and preferences that the browser stored badly or cannot store.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
  stubFetch(seeded.dashboard);
});
afterEach(() => cleanup());

describe('the keys of the shell', () => {
  it('opens the command menu with Ctrl+K as well as the command key, and closes it with the same key', async () => {
    openApp('#/cost');
    await inMain().findByText('Cost by day');
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command menu' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command menu' })).toBeNull();
  });

  it('closes the command menu with Escape', async () => {
    openApp('#/cost');
    await inMain().findByText('Cost by day');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByRole('combobox', { name: 'Search or run a command' });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command menu' })).toBeNull());
  });

  it('keeps a slash that the owner types in a field, and moves to the nav search otherwise', async () => {
    openApp('#/cost');
    await inMain().findByText('Cost by day');
    const nav = within(screen.getByRole('navigation', { name: 'pages' }));
    const field = nav.getByRole('searchbox');
    const typed = fireEvent.keyDown(field, { key: '/' });
    expect(typed).toBe(true);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(field);
  });

  it('toggles developer mode twice with the command key and the dot', async () => {
    openApp('#/cost');
    await inMain().findByText('Cost by day');
    const toggle = screen.getByRole('button', { name: 'Developer mode' });
    fireEvent.keyDown(window, { key: '.', ctrlKey: true });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: '.', metaKey: true });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('okc.prefs')!).devMode).toBe(false);
  });

  it('leaves Ctrl+K to the text fields on a mac, and names the key of the platform', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      openApp('#/cost');
      await inMain().findByText('Cost by day');
      expect(screen.getByRole('button', { name: 'Developer mode' }).getAttribute('title')).toBe('Developer mode (⌘.)');
      expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true })).toBe(true);
      expect(screen.queryByRole('dialog', { name: 'Command menu' })).toBeNull();
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      expect(screen.getByRole('dialog', { name: 'Command menu' })).toBeTruthy();
    } finally {
      platform.mockRestore();
    }
    cleanup();
    openApp('#/cost');
    await inMain().findByText('Cost by day');
    expect(screen.getByRole('button', { name: 'Developer mode' }).getAttribute('title')).toBe('Developer mode (Ctrl+.)');
  });
});

describe('the command menu', () => {
  it('lists the Sandbox page only in developer mode', () => {
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[]} />);
    const input = screen.getByRole('combobox', { name: 'Search or run a command' });
    fireEvent.change(input, { target: { value: 'sandbox' } });
    expect(screen.queryByRole('option', { name: /Sandbox/ })).toBeNull();
    act(() => setPrefs({ devMode: true }));
    expect(screen.getByRole('option', { name: /Sandbox/ })).toBeTruthy();
  });

  it('lists no dev page outside developer mode, and each of them in it', () => {
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[]} />);
    const pages = () => within(screen.getByRole('group', { name: 'Go to' }));
    const dev = () => pages().queryAllByRole('option').filter((option) => option.textContent?.endsWith('Dev'));
    expect(dev()).toEqual([]);
    for (const label of ['Runs', 'Sessions', 'Policy', 'Cost', 'Logs', 'Sandbox']) expect(pages().queryByRole('option', { name: label })).toBeNull();
    act(() => setPrefs({ devMode: true }));
    expect(dev().map((option) => option.querySelector('.cmdk-label')?.textContent)).toEqual(['Runs', 'Sessions', 'Policy', 'Cost', 'Logs', 'Sandbox']);
  });

  it('never lists a detail page, and wraps the arrow keys at both ends', () => {
    setPrefs({ devMode: true });
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[]} />);
    const input = screen.getByRole('combobox', { name: 'Search or run a command' });
    fireEvent.change(input, { target: { value: 'run' } });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).not.toContain('Run');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option').at(-1)!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id);
  });

  it('shows the error of a failed source in its place and keeps the pages', async () => {
    const source: CommandSource = { id: 'broken', label: 'Search', search: () => Promise.reject(new Error('the index is busy')) };
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[source]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search or run a command' }), { target: { value: 'goals' } });
    expect(await screen.findByText('Search: the index is busy')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Goals/ })).toBeTruthy();
  });

  it('asks a source nothing for spaces only, or below its shortest text', async () => {
    const search = vi.fn(() => Promise.resolve([]));
    const source: CommandSource = { id: 'short', label: 'Search', minQuery: 3, search };
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[source]} />);
    const input = screen.getByRole('combobox', { name: 'Search or run a command' });
    fireEvent.change(input, { target: { value: '     ' } });
    fireEvent.change(input, { target: { value: ' ab ' } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(search).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: ' abc ' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect((search.mock.calls[0] as unknown[])[0]).toBe('abc');
  });

  it('never shows the late answer of an older text', async () => {
    const answers: Record<string, (value: unknown) => void> = {};
    const source: CommandSource = {
      id: 'slow',
      label: 'Slow',
      search: (query) =>
        new Promise((resolve) => {
          answers[query] = resolve as (value: unknown) => void;
        }),
    };
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[source]} />);
    const input = screen.getByRole('combobox', { name: 'Search or run a command' });
    fireEvent.change(input, { target: { value: 'first' } });
    await waitFor(() => expect(answers.first).toBeDefined());
    fireEvent.change(input, { target: { value: 'second' } });
    await waitFor(() => expect(answers.second).toBeDefined());
    const group = (label: string) => [{ id: label, label, items: [{ id: label, label: `hit ${label}`, href: 'goals' }] }];
    await act(async () => answers.second!(group('second')));
    await act(async () => answers.first!(group('first')));
    expect(screen.getByRole('option', { name: /hit second/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /hit first/ })).toBeNull();
  });

  it('shows the error of a source that throws at once', async () => {
    const source: CommandSource = {
      id: 'sync',
      label: 'Search',
      search: () => {
        throw new Error('bad text');
      },
    };
    render(<CommandMenu open onClose={() => {}} routes={ROUTES} sources={[source]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search or run a command' }), { target: { value: 'goals' } });
    expect(await screen.findByText('Search: bad text')).toBeTruthy();
  });
});

describe('the stored preferences', () => {
  it('falls back to the defaults for stored text that is not json, or has wrong values', async () => {
    for (const stored of ['not json', JSON.stringify({ theme: 'neon', devMode: 'yes', detailsHidden: 1 }), 'null']) {
      localStorage.setItem('okc.prefs', stored);
      vi.resetModules();
      const prefs = await import('./prefs');
      const { result } = await import('@testing-library/react').then(({ renderHook }) => ({ result: renderHook(() => prefs.usePrefs()).result }));
      expect(result.current, stored).toEqual({ theme: 'system', devMode: false, detailsHidden: false });
      cleanup();
    }
  });

  it('keeps a change for the open page when the browser refuses to store it', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('the quota is full');
    });
    try {
      openApp('#/cost');
      await inMain().findByText('Cost by day');
      fireEvent.click(screen.getByRole('button', { name: 'Developer mode' }));
      expect(screen.getByRole('button', { name: 'Developer mode' }).getAttribute('aria-pressed')).toBe('true');
    } finally {
      setItem.mockRestore();
    }
  });

  it('sets the theme on the root element and removes it for the system theme', () => {
    setPrefs({ theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    setPrefs({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    setPrefs({ theme: 'system' });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe('the layout of the shell', () => {
  it('drops the dialog role of the nav sheet when the window gets wide', async () => {
    let width = 500;
    const queries = new Set<{ max: number; listeners: Set<() => void> }>();
    vi.stubGlobal('matchMedia', (text: string) => {
      const max = Number(/max-width: ([\d.]+)px/.exec(text)![1]);
      const query = { max, listeners: new Set<() => void>() };
      queries.add(query);
      return {
        get matches() {
          return width <= max;
        },
        addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
      };
    });
    try {
      openApp('#/cost');
      await inMain().findByText('Cost by day');
      fireEvent.click(screen.getByRole('button', { name: 'Open the navigation' }));
      expect(screen.getByRole('dialog', { name: 'navigation' })).toBeTruthy();
      width = 1400;
      act(() => {
        for (const query of queries) for (const listener of query.listeners) listener();
      });
      expect(screen.queryByRole('dialog', { name: 'navigation' })).toBeNull();
      expect(document.querySelector('.app')!.getAttribute('data-sheet')).toBe('closed');
    } finally {
      vi.unstubAllGlobals();
      installEventSource();
    }
  });
});
