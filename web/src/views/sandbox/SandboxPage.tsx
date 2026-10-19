import { useState } from 'react';
import type { BrowserLive, BrowserLiveTask, SandboxExecRow, SandboxExecStatus, SandboxPage as SandboxPageData } from '../../../../src/dashboard/types';
import { api, apiUrl, useApi } from '../../api';
import { Load } from '../../components';
import { bytes, ms, time } from '../../format';
import type { RouteProps } from '../../routes';
import { Button, ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, Page, Pill, Section, Select, Table, Tabs, type Column } from '../../ui';
import { ExecStatus, ExecSummary, limitFacts } from './parts';
import './sandbox.css';

type Tab = 'browser' | 'code';

const STATUSES: SandboxExecStatus[] = ['running', 'ok', 'failed', 'timeout', 'killed', 'error'];
const PAGE_SIZE = 50;

// the tab and the filters live in the query of the hash, so a link opens the same view.
function goTo(query: URLSearchParams, change: Record<string, string | null>): void {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(change)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const text = next.toString();
  location.hash = `#/sandbox${text ? `?${text}` : ''}`;
}

function LiveCard({ task }: { task: BrowserLiveTask }) {
  const step = task.latest;
  const href = `#/sandbox/browser/${encodeURIComponent(task.id)}`;
  return (
    <article className="sandbox-card" aria-label={`browser task ${task.id}`}>
      <a className="sandbox-card-shot" href={href} tabIndex={-1} aria-hidden="true">
        {step?.screenshotBlob ? (
          <img alt="" src={apiUrl(`/api/browser/screenshots/${step.screenshotBlob}`)} loading="lazy" />
        ) : (
          <span className="sandbox-noshot">no screenshot yet</span>
        )}
      </a>
      <div className="sandbox-card-body">
        <h3 className="sandbox-card-title">
          <a href={href}>
            {task.kind === 'search' ? 'Search' : 'Task'} {task.id.slice(0, 8)}
          </a>
        </h3>
        <Facts
          items={[
            { label: 'Last action', value: step ? `${step.action}${step.error ? ', failed' : ''}` : 'none yet' },
            { label: 'Page', value: <span className="sandbox-break">{step?.urlAfter ?? '-'}</span> },
            { label: 'Steps', value: task.steps },
            { label: 'Started', value: time(task.startedAt) },
            { label: 'Allowlist', value: task.allowlist.length ? task.allowlist.join(', ') : 'none' },
            task.runId !== null && {
              label: 'Run',
              value: <a href={`#/trace/${encodeURIComponent(task.runId)}`}>trace of run {task.runId.slice(0, 8)}</a>,
            },
          ]}
        />
        {step?.error ? <p className="error-text">{step.error}</p> : null}
      </div>
    </article>
  );
}

function BrowserTab() {
  const loaded = useApi<BrowserLive>('/api/browser/live', (message) => message.kind === 'browser_step');
  return (
    <Load loaded={loaded}>
      {({ tasks }) =>
        tasks.length ? (
          <div className="sandbox-cards">
            {tasks.map((task) => (
              <LiveCard key={task.id} task={task} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon="browser"
            title="No browser task is open."
            action={
              <ButtonLink size="sm" icon="browser" href="#/browser">
                Browser history
              </ButtonLink>
            }
          >
            A task shows here while the agent works in the browser, with its latest page.
          </EmptyState>
        )
      }
    </Load>
  );
}

const COLUMNS: Array<Column<SandboxExecRow>> = [
  { key: 'id', header: 'Id', cell: (exec) => `#${exec.id}` },
  { key: 'status', header: 'Status', cell: (exec) => <ExecStatus status={exec.status} /> },
  {
    key: 'command',
    header: 'Command',
    cell: (exec) => (
      <code className="sandbox-command" title={exec.command}>
        {exec.command}
      </code>
    ),
  },
  { key: 'image', header: 'Image', hideBelow: 'md', cell: (exec) => <code className="sandbox-mono">{exec.image}</code> },
  { key: 'network', header: 'Network', hideBelow: 'md', cell: (exec) => exec.network },
  { key: 'exit', header: 'Exit', align: 'end', cell: (exec) => exec.exitCode ?? '-' },
  { key: 'duration', header: 'Duration', align: 'end', hideBelow: 'sm', cell: (exec) => ms(exec.durationMs) },
  {
    key: 'output',
    header: 'Stdout / stderr',
    align: 'end',
    hideBelow: 'md',
    cell: (exec) => `${bytes(exec.stdoutBytes)} / ${bytes(exec.stderrBytes)}${exec.truncated ? ' cut' : ''}`,
  },
  { key: 'files', header: 'Files', align: 'end', hideBelow: 'md', cell: (exec) => exec.fileCount },
  { key: 'created', header: 'Created', align: 'end', hideBelow: 'sm', cell: (exec) => time(exec.createdAt) },
];

// the first page reloads when a tool call ends, so a new run shows. the older pages stay as they loaded.
function CodeList({ path }: { path: string }) {
  const first = useApi<SandboxPageData>(path, (message) => message.kind === 'tool_call');
  const [older, setOlder] = useState<{ execs: SandboxExecRow[]; before: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Load loaded={first}>
      {(page) => {
        const seen = new Set(page.execs.map((exec) => exec.id));
        const rows = [...page.execs, ...(older?.execs ?? []).filter((exec) => !seen.has(exec.id))];
        const before = older ? older.before : page.before;
        const loadOlder = () => {
          if (before === null) return;
          setBusy(true);
          setError(null);
          api<SandboxPageData>(`${path}&before=${before}`).then(
            (next) => {
              setBusy(false);
              setOlder({ execs: [...(older?.execs ?? []), ...next.execs], before: next.before });
            },
            (err: Error) => {
              setBusy(false);
              setError(err.message);
            },
          );
        };
        const exec = rows.find((row) => String(row.id) === selected);
        return (
          <>
            {page.status.available ? null : (
              <EmptyState icon="sandbox" title="The code sandbox is off.">
                {page.status.reason ?? 'The container engine does not answer.'} The rest of the app runs without it.
              </EmptyState>
            )}
            <Section title="Code runs">
              <Table
                label="code runs"
                dense
                columns={COLUMNS}
                rows={rows}
                rowKey={(row) => String(row.id)}
                selected={selected}
                onSelect={(row) => setSelected(String(row.id))}
                empty={<EmptyState icon="sandbox" title="No code ran in the sandbox yet." />}
              />
              <div className="sandbox-more">
                {before !== null ? (
                  <Button size="sm" busy={busy} onClick={loadOlder}>
                    Load older
                  </Button>
                ) : rows.length ? (
                  <span className="muted">That is all.</span>
                ) : null}
                {error ? <span className="error-text">{error}</span> : null}
              </div>
            </Section>
            <Section title="Engine">
              <Facts
                items={[
                  { label: 'Engine', value: page.status.engine ?? 'none' },
                  { label: 'Image', value: <code className="sandbox-mono">{page.status.image}</code> },
                  ...limitFacts(page.status.defaults),
                ]}
              />
            </Section>
            {exec ? (
              <DetailsPanel title={`Code run #${exec.id}`} openKey={exec.id} onClose={() => setSelected(null)}>
                <ExecSummary exec={exec} />
                <div>
                  <ButtonLink size="sm" variant="primary" icon="sandbox" href={`#/sandbox/code/${exec.id}`}>
                    Open the code run
                  </ButtonLink>
                </div>
              </DetailsPanel>
            ) : null}
          </>
        );
      }}
    </Load>
  );
}

function codePath(query: URLSearchParams): string {
  const params = new URLSearchParams();
  const status = query.get('status');
  const runId = query.get('runId');
  if (status) params.set('status', status);
  if (runId) params.set('runId', runId);
  params.set('limit', String(PAGE_SIZE));
  return `/api/sandbox?${params.toString()}`;
}

function CodeFilters({ query }: { query: URLSearchParams }) {
  const runId = query.get('runId');
  return (
    <>
      <Select label="status" value={query.get('status') ?? ''} allLabel="all" options={STATUSES} onChange={(value) => goTo(query, { status: value || null })} />
      {runId ? (
        <Pill icon="close" pressed onClick={() => goTo(query, { runId: null })} title="Clear the run filter">
          run {runId}
        </Pill>
      ) : null}
    </>
  );
}

export function SandboxPage({ query }: RouteProps) {
  const tab: Tab = query.get('tab') === 'code' ? 'code' : 'browser';
  const path = codePath(query);
  return (
    <Page
      title="Sandbox"
      subtitle="The browser and the code runs of the agent."
      width="full"
      toolbar={
        <FilterBar label="sandbox">
          <Tabs<Tab>
            label="sandbox"
            value={tab}
            onChange={(next) => goTo(query, { tab: next === 'browser' ? null : next })}
            items={[
              { id: 'browser', label: 'Browser' },
              { id: 'code', label: 'Code' },
            ]}
          />
          {tab === 'code' ? <CodeFilters query={query} /> : null}
        </FilterBar>
      }
    >
      <div className="sandbox-tab" role="tabpanel" aria-label={tab === 'browser' ? 'Browser' : 'Code'}>
        {tab === 'browser' ? <BrowserTab /> : <CodeList key={path} path={path} />}
      </div>
    </Page>
  );
}
