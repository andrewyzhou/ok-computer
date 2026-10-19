import type { BrowserOverview, BrowserStep, BrowserTaskDetail, SearchEngineState } from '../../../src/dashboard/browser-types';
import type { BlobBody } from '../../../src/dashboard/types';
import { apiUrl, useApi } from '../api';
import { Empty, Expand, Load, Page, Panel, Status } from '../components';
import { bytes, ms, time } from '../format';

// red for requests that the gate stopped, orange for requests that left after the owner approved a submit.
function Counts({ blocked, sent }: { blocked: number; sent: number }) {
  return (
    <>
      {blocked ? <span className="badge tone-critical">{blocked} blocked</span> : null} {sent ? <span className="badge tone-serious">{sent} sent</span> : null}
      {!blocked && !sent ? <span className="muted">none</span> : null}
    </>
  );
}

function Engine({ engine }: { engine: SearchEngineState }) {
  return (
    <li>
      <strong>{engine.label}</strong>{' '}
      {engine.paused ? (
        <>
          <Status value="paused" /> {engine.reason ?? 'paused'}, until {time(engine.until)}
          {engine.strikes > 1 ? <span className="muted"> (pause {engine.strikes} in a row)</span> : null}. Searches go to the other engine until then.
        </>
      ) : (
        <Status value="ready" />
      )}
    </li>
  );
}

export function BrowserTasks() {
  const loaded = useApi<BrowserOverview>('/api/browser', (message) => message.kind === 'run');
  return (
    <Page title="Browser">
      <Load loaded={loaded}>
        {({ engines, profileInUse, tasks }) => (
          <>
            <Panel title="Search engines">
              <ul>
                {engines.map((engine) => (
                  <Engine key={engine.id} engine={engine} />
                ))}
              </ul>
              <p className="muted">
                {profileInUse
                  ? 'The agent profile is open in a Chrome window now: the agent browser, or okc browser login. okc browser login works after it closes.'
                  : 'The agent profile is closed. okc browser login can open it now, for example to sign in or to answer a captcha.'}
              </p>
            </Panel>
            {tasks.length ? (
              <Panel title="Tasks and searches">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Session</th>
                      <th>Allowlist</th>
                      <th>Status</th>
                      <th>Steps</th>
                      <th>Requests</th>
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
                        <td>
                          <Counts blocked={task.blocked} sent={task.sent} />
                        </td>
                        <td>{time(task.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ) : (
              <Empty>The agent has not used the browser yet.</Empty>
            )}
          </>
        )}
      </Load>
    </Page>
  );
}

function Snapshot({ hash }: { hash: string }) {
  const loaded = useApi<BlobBody>(`/api/blobs/${hash}`);
  return <Load loaded={loaded}>{(blob) => <pre className="block">{blob.text}</pre>}</Load>;
}

// the risk of the tool call and the decision that let it run. an approved submit shows its approval.
function Policy({ step }: { step: BrowserStep }) {
  if (!step.risk && !step.decision) return null;
  return (
    <p>
      {step.risk ? <Status value={step.risk} /> : null} {step.decision ? <Status value={step.decision} /> : null}
      {step.rule ? <span className="muted"> by {step.rule}</span> : null}
      {step.approvalId !== null ? (
        <>
          {' · '}
          <a href="#/approvals">approval #{step.approvalId}</a>
        </>
      ) : null}
      {step.runId ? (
        <>
          {' · '}
          <a href={`#/runs/${encodeURIComponent(step.runId)}`}>tool call in run {step.runId.slice(0, 8)}</a>
        </>
      ) : null}
    </p>
  );
}

// each step is a frame of the replay: what the agent did, the page after it, and what the gate blocked or let out.
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
              <Status value={task.status} /> {task.endReason} · session {task.sessionKey} · allowlist {task.allowlist.join(', ')} · <Counts blocked={task.blocked} sent={task.sent} />
            </p>
            {task.hasTrace ? <p className="muted small">Open the trace zip with npx playwright-core show-trace.</p> : null}
          </Panel>
          {steps.length ? (
            steps.map((step) => (
              <Panel key={step.id} title={step.action} actions={<span className="muted">{time(step.createdAt)} · {ms(step.durationMs)}</span>}>
                {step.target ? <p className="wrap muted">{step.target}</p> : null}
                <p className="wrap">{step.urlBefore === step.urlAfter ? step.urlAfter : `${step.urlBefore} → ${step.urlAfter}`}</p>
                <Policy step={step} />
                {step.error ? <p className="error-box">{step.error}</p> : null}
                {step.blockedRequests.length ? (
                  <>
                    <h4>Did not leave this computer</h4>
                    <ul>
                      {step.blockedRequests.map((blocked, i) => (
                        <li key={i} className="wrap">
                          <span className="badge tone-critical">blocked</span> {blocked.url} <span className="muted">{blocked.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {step.sent.length ? (
                  <>
                    <h4>Sent after the owner's approval</h4>
                    <ul>
                      {step.sent.map((sent, i) => (
                        <li key={i} className="wrap">
                          <span className="badge tone-serious">{sent.form ? 'the form' : 'sent by the page'}</span> {sent.method} {sent.url}
                          {sent.body ? <code className="wrap small"> {sent.body}</code> : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {step.offsiteHosts.length ? (
                  <p className="wrap muted small">Also reached, off the allowlist: {step.offsiteHosts.join(', ')}</p>
                ) : null}
                {step.screenshotBlob ? (
                  <img className="shot" alt={`page after step ${step.id}`} src={apiUrl(`/api/browser/screenshots/${step.screenshotBlob}`)} />
                ) : (
                  <p className="muted">no screenshot</p>
                )}
                {step.snapshotBlob ? <Expand label="snapshot the model saw">{() => <Snapshot hash={step.snapshotBlob!} />}</Expand> : null}
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
