import type { ApprovalRow, Overview, RunRow } from '../../../src/dashboard/types';
import { useApi, useConnection, type Connection } from '../api';
import { usd } from '../format';
import { Icon } from '../icons';
import { KeyHint } from '../ui';
import { cycleTheme, toggleDevMode, usePrefs, type ThemePref } from './prefs';

const CONNECTION_TONE: Record<Connection, string> = { live: 'good', connecting: 'warning', offline: 'critical' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const;
const THEME_WORD: Record<ThemePref, string> = { system: 'system theme', light: 'light theme', dark: 'dark theme' };

// the status bar counts from the same endpoints as the pages, and the stream tells it when to load again.
export function StatusBar({ onSearch }: { onSearch: () => void }) {
  const { theme, devMode } = usePrefs();
  const connection = useConnection();
  const overview = useApi<Overview>('/api/overview', (message) => message.kind === 'run');
  const running = useApi<RunRow[]>('/api/runs?status=running', (message) => message.kind === 'run');
  const approvals = useApi<ApprovalRow[]>('/api/approvals', (message) => message.kind === 'approval' || message.kind === 'run');
  const pending = approvals.data?.filter((approval) => approval.status === 'pending').length;
  const runs = running.data?.length;
  return (
    <footer className="statusbar" aria-label="status bar">
      <span className="sb-item" title="the live event stream of the dashboard">
        <span className={`dot tone-${CONNECTION_TONE[connection]}`} aria-hidden="true" />
        {connection}
      </span>
      <a className="sb-item" href="#/runs?status=running">
        <Icon name="run" size={13} />
        {runs === undefined ? '-' : runs} running
      </a>
      <a className={pending ? 'sb-item is-warn' : 'sb-item'} href="#/approvals">
        <Icon name="approval" size={13} />
        {pending === undefined ? '-' : pending} <span className="sb-long">waiting for approval</span>
        <span className="sb-short">to approve</span>
      </a>
      <a className="sb-item" href="#/cost">
        <Icon name="cost" size={13} />
        {overview.data ? usd(overview.data.costUsd) : '-'} today
      </a>
      <span className="sb-space" />
      <button type="button" className="sb-item sb-search" onClick={onSearch}>
        <span className="sb-long">Search</span> <KeyHint keys={['mod', 'K']} />
      </button>
      <button type="button" className="sb-item sb-theme" onClick={cycleTheme} aria-label={`Theme: ${THEME_WORD[theme]}. Change the theme`} title="Change the theme">
        <Icon name={THEME_ICON[theme]} size={14} className="sb-keep" />
        <span className="sb-long">{theme}</span>
      </button>
      <button
        type="button"
        className={devMode ? 'sb-item dev-toggle is-on' : 'sb-item dev-toggle'}
        aria-pressed={devMode}
        aria-label="Developer mode"
        title="Developer mode (⌘.)"
        onClick={toggleDevMode}
      >
        {devMode ? 'DEV' : 'dev off'}
      </button>
    </footer>
  );
}
