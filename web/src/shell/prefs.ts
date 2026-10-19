import { useSyncExternalStore } from 'react';

// the preferences of this browser: the theme, developer mode and the details panel. they live in localStorage, and a
// browser that blocks storage keeps them for the open page only. a view reads developer mode with useDevMode.

export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  theme: ThemePref;
  devMode: boolean;
  // on a wide screen the owner can hide the details panel. a narrow screen shows the panel as a drawer instead.
  detailsHidden: boolean;
}

const KEY = 'okc.prefs';
const DEFAULTS: Prefs = { theme: 'system', devMode: false, detailsHidden: false };

function read(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
      devMode: stored.devMode === true,
      detailsHidden: stored.detailsHidden === true,
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const listeners = new Set<() => void>();

function applyTheme(theme: ThemePref): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}
applyTheme(prefs.theme);

export function setPrefs(change: Partial<Prefs>): void {
  prefs = { ...prefs, ...change };
  applyTheme(prefs.theme);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // the page keeps the change in memory when the browser refuses to store it.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => prefs, () => prefs);
}

export function useDevMode(): boolean {
  return usePrefs().devMode;
}

export function toggleDevMode(): void {
  setPrefs({ devMode: !prefs.devMode });
}

const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

export function cycleTheme(): void {
  setPrefs({ theme: NEXT_THEME[prefs.theme] });
}
