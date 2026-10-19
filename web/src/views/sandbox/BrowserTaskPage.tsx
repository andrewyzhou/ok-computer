import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BrowserStep, BrowserTaskDetail } from '../../../../src/dashboard/browser-types';
import { apiUrl, useApi } from '../../api';
import { bytes, ms, time } from '../../format';
import type { RouteProps } from '../../routes';
import { ButtonLink, CodeBlock, EmptyState, Facts, Page, Section, Status } from '../../ui';
import { LoadRow } from './parts';
import './sandbox.css';

const shotUrl = (hash: string) => apiUrl(`/api/browser/screenshots/${hash}`);

function List({ items, empty = 'none' }: { items: string[]; empty?: string }) {
  if (!items.length) return <>{empty}</>;
  return (
    <ul className="sandbox-list">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function StepView({ step, number }: { step: BrowserStep; number: number }) {
  return (
    <div className="sandbox-step" aria-live="polite">
      {step.screenshotBlob ? (
        <img className="sandbox-step-shot" alt={`page after step ${number}`} src={shotUrl(step.screenshotBlob)} />
      ) : (
        <p className="sandbox-noshot">No screenshot of step {number}.</p>
      )}
      <Facts
        items={[
          { label: 'Step', value: number },
          { label: 'Action', value: step.action },
          step.target !== null && { label: 'Target', value: <code className="sandbox-break">{step.target}</code> },
          { label: 'URL before', value: <span className="sandbox-break">{step.urlBefore ?? '-'}</span> },
          { label: 'URL after', value: <span className="sandbox-break">{step.urlAfter ?? '-'}</span> },
          { label: 'Time', value: `${time(step.createdAt)}, ${ms(step.durationMs)}` },
          step.error !== null && { label: 'Error', value: <span className="error-text">{step.error}</span> },
          step.decision !== null && {
            label: 'Policy',
            value: (
              <>
                <Status value={step.decision} /> {step.rule ? `by ${step.rule}` : null} {step.risk ? `, risk ${step.risk}` : null}
              </>
            ),
          },
          step.approvalId !== null && { label: 'Approval', value: <a href="#/approvals">#{step.approvalId}</a> },
          { label: 'Blocked requests', value: <List items={step.blockedRequests.map((each) => `${each.url} (${each.reason})`)} /> },
          { label: 'Sent requests', value: <List items={step.sent.map((each) => `${each.method} ${each.url}${each.form ? ', the approved form' : ''}`)} /> },
          step.offsiteHosts.length > 0 && { label: 'Hosts off the allowlist', value: <List items={step.offsiteHosts} /> },
          { label: 'Console errors', value: <List items={step.consoleErrors} /> },
          step.runId !== null && {
            label: 'Run',
            value: <a href={`#/trace/${encodeURIComponent(step.runId)}`}>trace of run {step.runId.slice(0, 8)}</a>,
          },
        ]}
      />
      {step.sent.some((each) => each.body) ? (
        <CodeBlock
          label="bodies of the sent requests, redacted"
          text={step.sent
            .filter((each) => each.body)
            .map((each) => `${each.method} ${each.url}\n${each.body}`)
            .join('\n\n')}
        />
      ) : null}
    </div>
  );
}

// a horizontal strip of the steps. the arrow keys, Home and End move the selection, as in a list box.
function Filmstrip({ steps, selected, onSelect }: { steps: BrowserStep[]; selected: number; onSelect: (index: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  // the strip opens on the latest step, which can be past the right edge of a narrow screen. it scrolls the strip only,
  // never the page.
  useEffect(() => {
    const box = strip.current;
    const option = box?.querySelectorAll<HTMLElement>('[role="option"]')[selected];
    if (!box || !option) return;
    if (option.offsetLeft + option.offsetWidth > box.scrollLeft + box.clientWidth || option.offsetLeft < box.scrollLeft)
      box.scrollLeft = option.offsetLeft - 8;
  }, [selected]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = steps.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(selected + 1, last)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(selected - 1, 0)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next);
    strip.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus({ preventScroll: true });
  };
  return (
    <div className="sandbox-strip" role="listbox" aria-label="steps" aria-orientation="horizontal" ref={strip} onKeyDown={keys}>
      {steps.map((step, index) => {
        const on = index === selected;
        return (
          <div
            key={step.id}
            role="option"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={['sandbox-frame', on ? 'is-on' : '', step.error ? 'is-error' : ''].filter(Boolean).join(' ')}
            onClick={() => onSelect(index)}
          >
            {step.screenshotBlob ? <img alt="" src={shotUrl(step.screenshotBlob)} loading="lazy" /> : <span className="sandbox-noshot">no screenshot</span>}
            <span className="sandbox-frame-label">
              <strong>{index + 1}</strong> {step.action}
              {step.error ? <span className="error-text"> failed</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TaskBody({ detail }: { detail: BrowserTaskDetail }) {
  const { task, steps } = detail;
  // null follows the latest step, so a live task shows each new step. a chosen step stays.
  const [chosen, setChosen] = useState<number | null>(null);
  const selected = chosen ?? steps.length - 1;
  const step = steps[selected];
  const traceUrl = apiUrl(`/api/browser/tasks/${encodeURIComponent(task.id)}/trace`);
  return (
    <>
      <Facts
        items={[
          { label: 'Status', value: <Status value={task.status} /> },
          { label: 'Kind', value: task.kind },
          { label: 'Session', value: task.sessionKey },
          task.runId !== null && {
            label: 'Run',
            value: (
              <>
                <a href={`#/trace/${encodeURIComponent(task.runId)}`}>trace</a> of{' '}
                <a href={`#/runs/${encodeURIComponent(task.runId)}`}>run {task.runId.slice(0, 8)}</a>
              </>
            ),
          },
          { label: 'Allowlist', value: task.allowlist.length ? task.allowlist.join(', ') : 'none' },
          { label: 'Time', value: `${time(task.startedAt)} to ${task.endedAt ? time(task.endedAt) : 'now'}` },
          { label: 'Steps', value: `${task.steps}, ${task.blocked} blocked requests, ${task.sent} sent` },
          task.endReason !== null && { label: 'End', value: task.endReason },
          {
            label: 'Trace',
            value: task.hasTrace ? (
              <a href={traceUrl} download>
                Download the trace zip{task.traceBytes !== null ? ` (${bytes(task.traceBytes)})` : ''}
              </a>
            ) : (
              <span className="muted">{task.traceError ?? (task.status === 'open' ? 'The trace is saved when the task ends.' : 'No trace.')}</span>
            ),
          },
        ]}
      />
      <Section title="Steps">
        {steps.length && step ? (
          <>
            <Filmstrip steps={steps} selected={selected} onSelect={(index) => setChosen(index === steps.length - 1 && task.status === 'open' ? null : index)} />
            <StepView step={step} number={selected + 1} />
          </>
        ) : (
          <EmptyState icon="browser" title="The task has no steps yet." />
        )}
      </Section>
    </>
  );
}

export function BrowserTaskPage({ params }: RouteProps) {
  const taskId = params.taskId ?? '';
  // the feed sends nothing when a task ends, so the page also reloads when the run of the task ends or makes a tool
  // call. the run id is known only after the first load, so it is read from a ref.
  const runId = useRef<string | null>(null);
  const loaded = useApi<BrowserTaskDetail>(
    `/api/browser/tasks/${encodeURIComponent(taskId)}`,
    (message) =>
      (message.kind === 'browser_step' && message.step.taskId === taskId) ||
      (message.kind === 'run' && message.run.id === runId.current) ||
      (message.kind === 'tool_call' && message.call.runId === runId.current),
  );
  runId.current = loaded.data?.task.runId ?? null;
  return (
    <Page
      title="Browser task"
      subtitle={<code>{taskId}</code>}
      width="full"
      crumbs={[{ label: 'Sandbox', href: '#/sandbox' }]}
      actions={
        loaded.data ? (
          <ButtonLink size="sm" icon="browser" href={`#/browser/${encodeURIComponent(taskId)}`}>
            In the browser history
          </ButtonLink>
        ) : undefined
      }
    >
      <LoadRow loaded={loaded} what="browser task" missing={<a href="#/sandbox">Go to the open tasks</a>}>
        {(detail) => <TaskBody detail={detail} />}
      </LoadRow>
    </Page>
  );
}
