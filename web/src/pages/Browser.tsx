import type { BrowserTaskDetail, BrowserTaskSummary } from '../../../src/dashboard/browser-types';
import type { BlobBody } from '../../../src/dashboard/types';
import { apiUrl, useApi } from '../api';
import { Empty, Expand, Load, Page, Panel, Status } from '../components';
import { bytes, ms, time } from '../format';

export function BrowserTasks() {
  const loaded = useApi<BrowserTaskSummary[]>('/api/browser/tasks', (message) => message.kind === 'run');
  return (
    <Page title="Browser">
      <Load loaded={loaded}>
        {(tasks) =>
          tasks.length ? (
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Session</th>
                  <th>Allowlist</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>Blocked</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <a href={`#/browser/${encodeURIComponent(task.id)}`}>{task.kind === 'search' ? 'search' : task.id.slice(0, 11)}</a>
                    </td>
                    <td>{task.sessionKey}</td>
                    <td className="wrap">{task.allowlist.join(', ')}</td>
                    <td>
                      <Status value={task.status} /> {task.endReason ? <span className="muted">{task.endReason}</span> : null}
                    </td>
                    <td>{task.steps}</td>
                    <td>{task.blocked ? <strong>{task.blocked}</strong> : 0}</td>
                    <td>{time(task.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>The agent has not used the browser yet.</Empty>
          )
        }
      </Load>
    </Page>
  );
}

function Snapshot({ hash }: { hash: string }) {
  const loaded = useApi<BlobBody>(`/api/blobs/${hash}`);
  return <Load loaded={loaded}>{(blob) => <pre className="block">{blob.text}</pre>}</Load>;
}

// each step is a frame of the replay: what the agent did, the page after it, and what the gate blocked.
export function BrowserTask({ id }: { id: string }) {
  const loaded = useApi<BrowserTaskDetail>(`/api/browser/tasks/${encodeURIComponent(id)}`, (message) => message.kind === 'run');
  return (
    <Load loaded={loaded}>
      {({ task, steps }) => (
        <Page
          title={`Browser ${task.kind} ${task.id.slice(0, 11)}`}
          actions={
            task.hasTrace ? (
              <a href={apiUrl(`/api/browser/tasks/${encodeURIComponent(task.id)}/trace`)}>trace zip ({bytes(task.traceBytes ?? 0)})</a>
            ) : (
              <span className="muted">{task.traceError ?? (task.status === 'open' ? 'the trace is saved when the task ends' : 'no trace')}</span>
            )
          }
        >
          <Panel title="Task">
            <p>
              <Status value={task.status} /> {task.endReason} · session {task.sessionKey} · allowlist {task.allowlist.join(', ')}
              {task.runId ? (
                <>
                  {' · '}
                  <a href={`#/runs/${encodeURIComponent(task.runId)}`}>run {task.runId.slice(0, 8)}</a>
                </>
              ) : null}
            </p>
          </Panel>
          {steps.length ? (
            steps.map((step) => (
              <Panel key={step.id} title={`${step.action}${step.target ? ` ${step.target.slice(0, 120)}` : ''}`} actions={<span className="muted">{time(step.createdAt)} · {ms(step.durationMs)}</span>}>
                <p className="wrap">
                  {step.urlBefore === step.urlAfter ? step.urlAfter : `${step.urlBefore} → ${step.urlAfter}`}
                </p>
                {step.error ? <p className="error-box">{step.error}</p> : null}
                {step.blockedRequests.length ? (
                  <ul>
                    {step.blockedRequests.map((blocked, i) => (
                      <li key={i} className="wrap">
                        <strong>blocked</strong> {blocked.url} <span className="muted">{blocked.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {step.screenshotBlob ? (
                  <img className="shot" alt={`page after step ${step.id}`} src={apiUrl(`/api/browser/screenshots/${step.screenshotBlob}`)} />
                ) : (
                  <p className="muted">no screenshot</p>
                )}
                {step.snapshotBlob ? <Expand label="snapshot">{() => <Snapshot hash={step.snapshotBlob!} />}</Expand> : null}
                {step.consoleErrors.length ? <Expand label={`${step.consoleErrors.length} console errors`}>{() => <pre className="block">{step.consoleErrors.join('\n')}</pre>}</Expand> : null}
              </Panel>
            ))
          ) : (
            <Empty>No steps.</Empty>
          )}
        </Page>
      )}
    </Load>
  );
}
