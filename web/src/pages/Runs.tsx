import { useState } from 'react';
import type { RunRow } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Empty, Load, Page, Status } from '../components';
import { duration, time, usd } from '../format';

const TRIGGERS = ['message', 'automation', 'heartbeat', 'consolidation', 'system'];
const SLOTS = ['main', 'heartbeat', 'utility', 'batch', 'consolidation', 'compaction'];
const STATUSES = ['running', 'completed', 'failed', 'aborted'];

export function sessionHref(sessionKey: string): string {
  return `#/sessions/${encodeURIComponent(sessionKey)}`;
}

export function Runs() {
  const [filter, setFilter] = useState({ trigger: '', slot: '', status: '', day: '' });
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  const loaded = useApi<RunRow[]>(`/api/runs${query ? `?${query}` : ''}`, (message) => message.kind === 'run');
  const select = (key: 'trigger' | 'slot' | 'status', options: string[]) => (
    <label>
      {key}
      <select value={filter[key]} onChange={(event) => setFilter({ ...filter, [key]: event.target.value })}>
        <option value="">all</option>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
  return (
    <Page title="Runs">
      <div className="filters">
        {select('trigger', TRIGGERS)}
        {select('slot', SLOTS)}
        {select('status', STATUSES)}
        <label>
          day
          <input type="date" value={filter.day} onChange={(event) => setFilter({ ...filter, day: event.target.value })} />
        </label>
      </div>
      <Load loaded={loaded}>
        {(runs) =>
          runs.length ? (
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Run</th>
                  <th>Session</th>
                  <th>Trigger</th>
                  <th>Slot</th>
                  <th>Status</th>
                  <th className="num">Model calls</th>
                  <th className="num">Tool calls</th>
                  <th className="num">Cost</th>
                  <th className="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{time(run.startedAt)}</td>
                    <td>
                      <a href={`#/runs/${encodeURIComponent(run.id)}`}>{run.id.slice(0, 8)}</a>
                    </td>
                    <td>
                      <a href={sessionHref(run.sessionKey)}>{run.sessionKey}</a>
                    </td>
                    <td>{run.trigger}</td>
                    <td>{run.slot}</td>
                    <td>
                      <Status value={run.status} />
                    </td>
                    <td className="num">{run.modelCalls}</td>
                    <td className="num">{run.toolCalls}</td>
                    <td className="num">{usd(run.costUsd)}</td>
                    <td className="num">{duration(run.startedAt, run.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No runs match the filters.</Empty>
          )
        }
      </Load>
    </Page>
  );
}
