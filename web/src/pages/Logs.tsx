import { useEffect, useState } from 'react';
import type { LogLine } from '../../../src/dashboard/types';
import { api, useStream } from '../api';
import { Empty, Page, Status } from '../components';
import { time } from '../format';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const KEEP = 2000;

const atLeast = (line: LogLine, level: string) => LEVELS.indexOf(line.level) >= LEVELS.indexOf(level);

export function Logs() {
  const [level, setLevel] = useState('info');
  const [lines, setLines] = useState<LogLine[] | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setLines(undefined);
    api<LogLine[]>(`/api/logs?level=${level}&limit=500`).then(
      (loaded) => current && setLines(loaded),
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [level]);

  useStream((message) => {
    if (message.kind !== 'log' || !atLeast(message.line, level)) return;
    setLines((old) => (old ? [...old, message.line].slice(-KEEP) : old));
  });

  return (
    <Page
      title="Logs"
      actions={
        <label>
          level at least{' '}
          <select value={level} onChange={(event) => setLevel(event.target.value)}>
            {LEVELS.map((each) => (
              <option key={each}>{each}</option>
            ))}
          </select>
        </label>
      }
    >
      {error ? <p className="error-box">Could not load: {error}</p> : null}
      {lines === undefined ? (
        <p className="muted">Loading…</p>
      ) : lines.length ? (
        <ol className="log-lines">
          {[...lines].reverse().map((line, i) => {
            const { ts, level: lineLevel, msg, ...fields } = line;
            return (
              <li key={`${ts}-${lines.length - i}`}>
                <span className="muted">{time(ts)}</span> <Status value={lineLevel} /> <strong>{msg}</strong>{' '}
                <code className="fields">{Object.keys(fields).length ? JSON.stringify(fields) : ''}</code>
              </li>
            );
          })}
        </ol>
      ) : (
        <Empty>No log lines today at this level.</Empty>
      )}
    </Page>
  );
}
