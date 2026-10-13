import { useState } from 'react';
import type { AutomationRow, AutomationRunRow, HeartbeatStatus } from '../../../src/dashboard/types';
import { send, useApi } from '../api';
import { Empty, Expand, Load, Page, Panel, Status } from '../components';
import { duration, time } from '../format';

function History({ id }: { id: string }) {
  const loaded = useApi<AutomationRunRow[]>(`/api/automations/${encodeURIComponent(id)}/runs`, (message) => message.kind === 'run');
  return (
    <Load loaded={loaded}>
      {(runs) =>
        runs.length ? (
          <ul className="list">
            {runs.map((run) => (
              <li key={run.id}>
                <Status value={run.status} /> {time(run.startedAt)}, {duration(run.startedAt, run.endedAt)}
                {run.runId ? (
                  <>
                    {' '}
                    · <a href={`#/runs/${encodeURIComponent(run.runId)}`}>run {run.runId.slice(0, 8)}</a>
                  </>
                ) : null}
                {run.error ? <span className="muted"> · {run.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>This automation did not run yet.</Empty>
        )
      }
    </Load>
  );
}

function Checklist() {
  const loaded = useApi<HeartbeatStatus>('/api/heartbeat');
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState('');
  return (
    <Panel title="Heartbeat checklist">
      <Load loaded={loaded}>
        {(status) => (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              send('/api/heartbeat/checklist', 'PUT', { checklist: draft ?? status.checklist }).then(
                () => {
                  setNotice('Saved.');
                  setDraft(undefined);
                  loaded.reload();
                },
                (err: Error) => setNotice(err.message),
              );
            }}
          >
            <p className="muted small">The heartbeat checks these items every {status.every} during active hours. An empty list stops the checks.</p>
            <textarea
              aria-label="heartbeat checklist"
              rows={5}
              value={draft ?? status.checklist}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="row">
              <button type="submit" disabled={draft === undefined}>
                Save checklist
              </button>
              <span className="muted">{notice}</span>
            </div>
          </form>
        )}
      </Load>
    </Panel>
  );
}

export function Automations() {
  const loaded = useApi<AutomationRow[]>('/api/automations', (message) => message.kind === 'run');
  const [notice, setNotice] = useState('');
  const act = (promise: Promise<unknown>, done: string) =>
    promise.then(
      () => {
        setNotice(done);
        loaded.reload();
      },
      (err: Error) => setNotice(err.message),
    );
  return (
    <Page title="Automations" actions={<span className="muted">{notice}</span>}>
      <Load loaded={loaded}>
        {(automations) =>
          automations.length ? (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Schedule</th>
                  <th>Next run</th>
                  <th>Last run</th>
                  <th>State</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {automations.map((automation) => (
                  <tr key={automation.id}>
                    <td>
                      <strong>{automation.name}</strong>
                      <div className="muted small">
                        {automation.id} · {automation.payloadType} · {automation.sessionMode} session · by {automation.createdBy}
                      </div>
                      <Expand label="history">{() => <History id={automation.id} />}</Expand>
                    </td>
                    <td>{automation.schedule}</td>
                    <td>{time(automation.nextRunAt)}</td>
                    <td>{time(automation.lastRunAt)}</td>
                    <td>
                      <Status value={automation.enabled ? 'on' : 'off'} />
                      {automation.consecutiveFailures ? (
                        <div className="error-text small">{automation.consecutiveFailures} failures in a row</div>
                      ) : null}
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        onClick={() =>
                          act(
                            send(`/api/automations/${encodeURIComponent(automation.id)}`, 'POST', { enabled: !automation.enabled }),
                            `${automation.name} is ${automation.enabled ? 'off' : 'on'}.`,
                          )
                        }
                      >
                        {automation.enabled ? 'Turn off' : 'Turn on'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          act(send(`/api/automations/${encodeURIComponent(automation.id)}/run`, 'POST', {}), `${automation.name} started.`)
                        }
                      >
                        Run now
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No automations yet.</Empty>
          )
        }
      </Load>
      <Checklist />
    </Page>
  );
}
