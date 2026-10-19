import { useState } from 'react';
import type { BrowserOverview, BrowserStep, BrowserTaskDetail, BrowserTaskSummary, SearchEngineState } from '../../../src/dashboard/browser-types';
import type { BlobBody } from '../../../src/dashboard/types';
import { apiUrl, useApi } from '../api';
import { Expand, Load } from '../components';
import { bytes, ms, time } from '../format';
import { Badge, ButtonLink, DetailsPanel, EmptyState, Facts, NotFound, Page, Section, Status, Table, type Column, type Fact } from '../ui';
import './connections.css';

const taskHref = (id: string) => `#/browser/${encodeURIComponent(id)}`;
const taskName = (task: BrowserTaskSummary) => (task.kind === 'search' ? 'search' : task.id.slice(0, 11));

// critical for requests that the gate stopped, serious for requests that left after the owner approved a submit.
function Counts({ blocked, sent }: { blocked: number; sent: number }) {
  return (
    <span className="browser-counts">
      {blocked ? <Badge tone="critical">{blocked} blocked</Badge> : null}
      {sent ? <Badge tone="serious">{sent} sent</Badge> : null}
      {!blocked && !sent ? <span className="muted">none</span> : null}
    </span>
  );
}

function Engine({ engine }: { engine: SearchEngineState }) {
  return (
    <li>
      <strong>{engine.label}</strong>{' '}
      {engine.paused ? (
        <span>
          <Status value="paused" /> {engine.reason ?? 'paused'}, until {time(engine.until)}
          {engine.strikes > 1 ? <span className="muted"> (pause {engine.strikes} in a row)</span> : null}. Searches go to the other engine until then.
        </span>
      ) : (
        <Status value="ready" />
      )}
    </li>
  );
}

// the trace of a task, or the reason why it has none. the trace zip is the full record of the task.
function Trace({ task }: { task: BrowserTaskSummary }) {
  if (task.hasTrace) {
    return (
      <a href={apiUrl(`/api/browser/tasks/${encodeURIComponent(task.id)}/trace`)} download>
        trace zip ({bytes(task.traceBytes ?? 0)})
      </a>
    );
  }
  return <span className="muted">{task.traceError ?? (task.status === 'open' ? 'the trace is saved when the task ends' : 'no trace')}</span>;
}

function taskFacts(task: BrowserTaskSummary): Fact[] {
  return [
    {
      label: 'Status',
      value: (
        <>
          <Status value={task.status} /> {task.endReason ? <span className="muted">{task.endReason}</span> : null}
        </>
      ),
    },
    { label: 'Allowlist', value: task.allowlist.length ? task.allowlist.join(', ') : <span className="muted">empty</span> },
    { label: 'Session', value: task.sessionKey },
    { label: 'Requests', value: <Counts blocked={task.blocked} sent={task.sent} /> },
    { label: 'Steps', value: task.steps },
    { label: 'Started', value: time(task.startedAt) },
    { label: 'Ended', value: task.endedAt ? time(task.endedAt) : <span className="muted">{task.status === 'open' ? 'not yet' : 'no end time was saved'}</span> },
    { label: 'Trace', value: <Trace task={task} /> },
  ];
}

const TASK_COLUMNS: Array<Column<BrowserTaskSummary>> = [
  { key: 'task', header: 'Task', cell: (task) => <a href={taskHref(task.id)}>{taskName(task)}</a> },
  { key: 'allowlist', header: 'Allowlist', cell: (task) => (task.allowlist.length ? <span className="browser-hosts">{task.allowlist.join(', ')}</span> : <span className="muted">empty</span>) },
  {
    key: 'status',
    header: 'Status',
    wrap: true,
    cell: (task) => (
      <>
        <Status value={task.status} /> {task.endReason ? <span className="muted">{task.endReason}</span> : null}
      </>
    ),
  },
  { key: 'session', header: 'Session', cell: (task) => task.sessionKey, hideBelow: 'md' },
  { key: 'steps', header: 'Steps', cell: (task) => task.steps, align: 'end', hideBelow: 'sm' },
  { key: 'requests', header: 'Requests', cell: (task) => <Counts blocked={task.blocked} sent={task.sent} />, hideBelow: 'sm' },
  { key: 'started', header: 'Started', cell: (task) => time(task.startedAt), align: 'end', hideBelow: 'md' },
];

function BrowserBody({ data }: { data: BrowserOverview }) {
  const { engines, profileInUse, tasks } = data;
  const [selected, setSelected] = useState<string | null>(null);
  const task = tasks.find((each) => each.id === selected);
  return (
    <>
      <Section title="Tasks and searches" description="Select one to see its summary. Open it to replay it step by step.">
        <Table
          label="browser tasks"
          columns={TASK_COLUMNS}
          rows={tasks}
          rowKey={(each) => each.id}
          selected={selected}
          onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
          empty={<EmptyState icon="browser" title="The agent has not used the browser yet." />}
        />
      </Section>
      <Section title="Search engines">
        <ul className="browser-engines">
          {engines.map((engine) => (
            <Engine key={engine.id} engine={engine} />
          ))}
        </ul>
        <p className="muted small browser-profile">
          {profileInUse
            ? 'The agent profile is open in a Chrome window now: the agent browser, or okc browser login. okc browser login works after it closes.'
            : 'The agent profile is closed. okc browser login can open it now, for example to sign in or to answer a captcha.'}
        </p>
      </Section>
      {task ? (
        <DetailsPanel
          title={`${task.kind === 'search' ? 'Search' : 'Task'} ${task.id.slice(0, 11)}`}
          openKey={task.id}
          onClose={() => setSelected(null)}
          actions={
            <ButtonLink href={taskHref(task.id)} size="sm" icon="browser">
              Open
            </ButtonLink>
          }
        >
          <Facts layout="stacked" items={taskFacts(task)} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Browser">
          <Facts
            layout="stacked"
            items={[
              { label: 'Agent profile', value: profileInUse ? 'open now' : 'closed' },
              { label: 'Tasks', value: tasks.length },
              { label: 'Open now', value: tasks.filter((each) => each.status === 'open').length },
              { label: 'Blocked requests', value: tasks.reduce((sum, each) => sum + each.blocked, 0) },
              { label: 'Engines paused', value: engines.filter((each) => each.paused).length },
            ]}
          />
          <p className="muted small">Select a task to see its summary.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function BrowserTasks() {
  const loaded = useApi<BrowserOverview>('/api/browser', (message) => message.kind === 'run');
  return (
    <Page title="Browser" subtitle="The tasks of the agent browser, and the search engines">
      <Load loaded={loaded}>{(data) => <BrowserBody data={data} />}</Load>
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
    <p className="browser-policy">
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

const url = (step: BrowserStep) => (step.urlBefore === step.urlAfter ? step.urlAfter : `${step.urlBefore} → ${step.urlAfter}`);

// one frame of the replay: what the agent did, the page after it, and what the gate blocked or let out.
function Frame({ step, number, selected }: { step: BrowserStep; number: number; selected: boolean }) {
  return (
    <section id={`browser-step-${number}`} className={`browser-frame${selected ? ' is-selected' : ''}`} aria-labelledby={`browser-step-${number}-title`}>
      <header className="browser-frame-head">
        <h2 id={`browser-step-${number}-title`} className="browser-frame-title">
          <span className="muted">Step {number}</span> {step.action}
        </h2>
        <span className="muted small">
          {time(step.createdAt)} · {ms(step.durationMs)}
        </span>
      </header>
      <div className="browser-frame-body">
        <div className="browser-frame-shot">
          {step.screenshotBlob ? (
            <img className="browser-shot" alt={`page after step ${number}`} src={apiUrl(`/api/browser/screenshots/${step.screenshotBlob}`)} />
          ) : (
            <p className="browser-noshot muted">no screenshot</p>
          )}
        </div>
        <div className="browser-frame-info">
          {step.target ? <p className="browser-target">{step.target}</p> : null}
          <p className="browser-url">{url(step)}</p>
          <Policy step={step} />
          {step.error ? <p className="error-box">{step.error}</p> : null}
          {step.blockedRequests.length ? (
            <div>
              <h3 className="browser-subhead">Did not leave this computer</h3>
              <ul className="browser-requests">
                {step.blockedRequests.map((blocked, i) => (
                  <li key={i}>
                    <Badge tone="critical">blocked</Badge> <span>{blocked.url}</span> <span className="muted">{blocked.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {step.sent.length ? (
            <div>
              <h3 className="browser-subhead">Sent after the owner's approval</h3>
              <ul className="browser-requests">
                {step.sent.map((sent, i) => (
                  <li key={i}>
                    <Badge tone="serious">{sent.form ? 'the form' : 'sent by the page'}</Badge> {sent.method} {sent.url}
                    {sent.body ? <code className="browser-body"> {sent.body}</code> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {step.offsiteHosts.length ? <p className="muted small browser-url">Also reached, off the allowlist: {step.offsiteHosts.join(', ')}</p> : null}
          {step.snapshotBlob ? <Expand label="snapshot the model saw">{() => <Snapshot hash={step.snapshotBlob!} />}</Expand> : null}
          {step.consoleErrors.length ? (
            <Expand label={`${step.consoleErrors.length} console errors`}>{() => <pre className="block">{step.consoleErrors.join('\n')}</pre>}</Expand>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// the strip of small frames at the top of the replay. a press selects a step, shows its facts in the details panel
// and scrolls to its frame.
function Filmstrip({ steps, selected, onSelect }: { steps: BrowserStep[]; selected: number; onSelect: (index: number) => void }) {
  return (
    <ol className="browser-filmstrip" aria-label="steps">
      {steps.map((step, index) => {
        const problem = step.error ? 'failed' : step.blockedRequests.length ? 'blocked' : step.sent.length ? 'sent' : null;
        return (
          <li key={step.id}>
            <button
              type="button"
              className={`browser-thumb${index === selected ? ' is-on' : ''}`}
              aria-pressed={index === selected}
              aria-label={`Step ${index + 1}, ${step.action}${problem ? `, ${problem}` : ''}`}
              onClick={() => onSelect(index)}
            >
              {step.screenshotBlob ? (
                <img alt="" src={apiUrl(`/api/browser/screenshots/${step.screenshotBlob}`)} />
              ) : (
                <span className="browser-thumb-none" aria-hidden="true" />
              )}
              <span className="browser-thumb-label">
                <span className="muted">{index + 1}</span> {step.action}
              </span>
              {problem ? (
                <span className={`browser-thumb-flag browser-flag-${problem === 'sent' ? 'serious' : 'critical'}`} aria-hidden="true">
                  {problem}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function stepFacts(step: BrowserStep, number: number): Array<Fact | false> {
  return [
    { label: 'Step', value: `${number}, ${step.action}` },
    { label: 'At', value: `${time(step.createdAt)}, ${ms(step.durationMs)}` },
    Boolean(step.risk) && { label: 'Risk', value: <Status value={step.risk!} /> },
    Boolean(step.decision) && { label: 'Decision', value: <Status value={step.decision!} /> },
    { label: 'Blocked', value: step.blockedRequests.length },
    { label: 'Sent', value: step.sent.length },
  ];
}

function TaskBody({ detail, initial }: { detail: BrowserTaskDetail; initial: number }) {
  const { task, steps } = detail;
  const [selected, setSelected] = useState(Math.min(Math.max(initial, 0), Math.max(steps.length - 1, 0)));
  const step = steps[selected];
  const select = (index: number) => {
    setSelected(index);
    // the dom of the tests has no scrollIntoView, so the call is optional.
    document.getElementById(`browser-step-${index + 1}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  return (
    <>
      <DetailsPanel title={`${task.kind === 'search' ? 'Search' : 'Task'} ${task.id.slice(0, 11)}`}>
        <Facts layout="stacked" items={taskFacts(task)} />
        {task.hasTrace ? <p className="muted small">Open the trace zip with npx playwright-core show-trace.</p> : null}
        {step ? (
          <Section title={`Selected step ${selected + 1}`}>
            <Facts layout="stacked" items={stepFacts(step, selected + 1)} />
          </Section>
        ) : null}
      </DetailsPanel>
      {steps.length ? (
        <>
          <Filmstrip steps={steps} selected={selected} onSelect={select} />
          <div className="browser-frames">
            {steps.map((each, index) => (
              <Frame key={each.id} step={each} number={index + 1} selected={index === selected} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState icon="browser" title="No steps." />
      )}
    </>
  );
}

// the replay of a task: a filmstrip of its steps, and a frame for each step.
export function BrowserTask({ id, query }: { id: string; query?: URLSearchParams }) {
  const loaded = useApi<BrowserTaskDetail>(`/api/browser/tasks/${encodeURIComponent(id)}`, (message) => message.kind === 'run');
  const task = loaded.data?.task;
  // ?step=2 opens the replay at the second step.
  const initial = Number(query?.get('step') ?? 1) - 1;
  return (
    <Page
      title={task ? `${task.kind === 'search' ? 'Search' : 'Task'} ${task.id.slice(0, 11)}` : 'Browser task'}
      subtitle={task ? `${task.allowlist.length ? task.allowlist.join(', ') : 'no allowlist'} · ${task.steps} steps · ${time(task.startedAt)}` : undefined}
      crumbs={[{ label: 'Browser', href: '#/browser' }]}
    >
      <Load
        loaded={loaded}
        notFound={
          <NotFound icon="browser" what="browser task">
            <a href="#/browser">Go to the browser history</a>
          </NotFound>
        }
      >
        {(detail) => <TaskBody detail={detail} initial={Number.isFinite(initial) ? initial : 0} />}
      </Load>
    </Page>
  );
}
