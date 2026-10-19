import { useEffect, useState } from 'react';
import type { LogLine } from '../../../src/dashboard/types';
import { api, useStream } from '../api';
import { Status } from '../components';
import { time } from '../format';
import type { RouteProps } from '../routes';
import { EmptyState, FilterBar, IconButton, Page, Pill, Select, Skeleton } from '../ui';
import { runHref, setHashQuery } from './Runs';
import './dev.css';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const KEEP = 2000;

const atLeast = (line: LogLine, level: string) => LEVELS.indexOf(line.level) >= LEVELS.indexOf(level);

// the server keeps the lines of the run when it knows the filter. the page checks the run id too, so a live line of
// another run never shows.
const ofRun = (line: LogLine, runId: string) => !runId || line.runId === runId;

function LogRow({ line }: { line: LogLine }) {
  const { ts, level, msg, ...fields } = line;
  const runId = typeof fields.runId === 'string' ? fields.runId : null;
  return (
    <li className={`logs-line logs-${level}`}>
      <span className="logs-time">{time(ts)}</span>
      <Status value={level} />
      <span className="logs-text">
        <strong className="logs-msg">{msg}</strong>
        {runId ? (
          <a className="logs-run" href={runHref(runId)}>
            run {runId.slice(0, 8)}
          </a>
        ) : null}
        {Object.keys(fields).length ? <code className="logs-fields">{JSON.stringify(fields)}</code> : null}
      </span>
    </li>
  );
}

export function Logs({ query = new URLSearchParams() }: Partial<RouteProps>) {
  const level = LEVELS.includes(query.get('level') ?? '') ? query.get('level')! : 'info';
  const rawDay = query.get('day') ?? '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : '';
  const runId = query.get('runId') ?? '';
  const [lines, setLines] = useState<LogLine[] | undefined>(undefined);
  const [error, setError] = useState('');
  const set = (change: Record<string, string>) => setHashQuery('logs', change);

  useEffect(() => {
    let current = true;
    setLines(undefined);
    setError('');
    const params = new URLSearchParams({ level, limit: '500' });
    if (day) params.set('day', day);
    if (runId) params.set('runId', runId);
    api<LogLine[]>(`/api/logs?${params}`).then(
      (loaded) => current && setLines(loaded.filter((line) => ofRun(line, runId))),
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [level, day, runId]);

  // the stream sends the lines of today only, so another day shows no live lines.
  useStream((message) => {
    if (message.kind !== 'log' || day || !atLeast(message.line, level) || !ofRun(message.line, runId)) return;
    setLines((old) => (old ? [...old, message.line].slice(-KEEP) : old));
  });

  return (
    <Page
      title="Logs"
      subtitle={day ? `The lines of ${day}, newest first.` : 'The lines of today, newest first. New lines come in live.'}
      width="full"
      toolbar={
        <FilterBar
          end={
            runId ? (
              <Pill icon="run" className="dev-filter-pill">
                run <code className="dev-id">{runId.slice(0, 8)}</code>
                <IconButton icon="close" size="sm" label="Clear the run filter" onClick={() => set({ runId: '' })} />
              </Pill>
            ) : null
          }
        >
          <Select label="level at least" value={level} options={LEVELS} onChange={(value) => set({ level: value === 'info' ? '' : value })} />
          <label className={`dev-date${day ? ' is-set' : ''}`}>
            <span>day</span>
            <input type="date" aria-label="day" value={day} onChange={(event) => set({ day: event.target.value })} />
          </label>
        </FilterBar>
      }
    >
      {error ? <p className="error-box">Could not load: {error}</p> : null}
      {lines === undefined ? (
        error ? null : (
          <Skeleton lines={6} />
        )
      ) : lines.length ? (
        <ol className="logs-lines" aria-label="log lines">
          {[...lines].reverse().map((line, i) => (
            <LogRow key={`${line.ts}-${lines.length - i}`} line={line} />
          ))}
        </ol>
      ) : (
        <EmptyState
          icon="log"
          title={runId ? 'No log lines of this run at this level.' : day ? 'No log lines on this day at this level.' : 'No log lines today at this level.'}
        />
      )}
    </Page>
  );
}
