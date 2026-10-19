import { useState } from 'react';
import type { RunRow } from '../../../src/dashboard/types';
import { api, useApi } from '../api';
import { Load, Status } from '../components';
import { duration, time, usd } from '../format';
import type { RouteProps } from '../routes';
import { Button, ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, IconButton, Page, Pill, Select, Table, type Column } from '../ui';
import './dev.css';

const TRIGGERS = ['message', 'automation', 'heartbeat', 'consolidation', 'system', 'subagent', 'poll'];
const SLOTS = ['main', 'heartbeat', 'utility', 'batch', 'consolidation', 'compaction'];
const STATUSES = ['running', 'completed', 'failed', 'aborted'];
const FILTERS = ['trigger', 'slot', 'status', 'day', 'sessionKey'] as const;
const PAGE_SIZE = 50;

export function sessionHref(sessionKey: string): string {
  return `#/sessions/${encodeURIComponent(sessionKey)}`;
}

export function runHref(runId: string): string {
  return `#/runs/${encodeURIComponent(runId)}`;
}

// the filters of a list page live in the query of the hash, so a link can open a filtered list and the back button
// undoes a filter. an empty value leaves its key out. the change starts from the hash itself and not from the props,
// because the props follow the hash only after its change event, and two quick changes must both stay.
export function setHashQuery(path: string, change: Record<string, string>): void {
  const raw = location.hash.replace(/^#?\/?/, '');
  const at = raw.indexOf('?');
  const current = at < 0 ? raw : raw.slice(0, at);
  const search = at < 0 ? '' : raw.slice(at + 1);
  const next = new URLSearchParams(current === path ? search : '');
  for (const [key, value] of Object.entries(change)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const text = next.toString();
  location.hash = `#/${path}${text ? `?${text}` : ''}`;
}

function filtersOf(query: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of FILTERS) {
    const value = query.get(key);
    if (value && (key !== 'day' || /^\d{4}-\d{2}-\d{2}$/.test(value))) out.set(key, value);
  }
  return out;
}

const COLUMNS: Array<Column<RunRow>> = [
  { key: 'started', header: 'Started', cell: (run) => time(run.startedAt) },
  {
    key: 'run',
    header: 'Run',
    cell: (run) => (
      <a className="runs-id" href={runHref(run.id)}>
        {run.id.slice(0, 8)}
      </a>
    ),
  },
  { key: 'session', header: 'Session', cell: (run) => <a href={sessionHref(run.sessionKey)}>{run.sessionKey}</a>, hideBelow: 'sm' },
  { key: 'trigger', header: 'Trigger', cell: (run) => run.trigger, hideBelow: 'md' },
  { key: 'slot', header: 'Slot', cell: (run) => run.slot, hideBelow: 'md' },
  { key: 'status', header: 'Status', cell: (run) => <Status value={run.status} /> },
  { key: 'model', header: 'Model calls', cell: (run) => run.modelCalls, align: 'end', hideBelow: 'md' },
  { key: 'tools', header: 'Tool calls', cell: (run) => run.toolCalls, align: 'end', hideBelow: 'md' },
  { key: 'cost', header: 'Cost', cell: (run) => usd(run.costUsd), align: 'end', hideBelow: 'sm' },
  { key: 'duration', header: 'Duration', cell: (run) => duration(run.startedAt, run.endedAt), align: 'end', hideBelow: 'sm' },
];

export function RunFacts({ run }: { run: RunRow }) {
  return (
    <Facts
      layout="stacked"
      items={[
        { label: 'Run id', value: <code className="dev-id">{run.id}</code> },
        {
          label: 'Status',
          value: (
            <>
              <Status value={run.status} /> {run.error ? <span className="error-text">{run.error}</span> : null}
            </>
          ),
        },
        { label: 'Session', value: <a href={sessionHref(run.sessionKey)}>{run.sessionKey}</a> },
        { label: 'Trigger', value: `${run.trigger}, slot ${run.slot}` },
        { label: 'Started', value: time(run.startedAt) },
        { label: 'Ended', value: run.endedAt ? time(run.endedAt) : 'still running' },
        { label: 'Duration', value: duration(run.startedAt, run.endedAt) },
        { label: 'Cost', value: `${usd(run.costUsd)} in ${run.modelCalls} model calls and ${run.toolCalls} tool calls` },
      ]}
    />
  );
}

// the older pages stay below the newest page. a reload of the newest page after a stream message keeps them, and a
// run that is on both pages shows once, in its newest place.
function merge(first: RunRow[], older: RunRow[]): RunRow[] {
  const seen = new Set(first.map((run) => run.id));
  return [...first, ...older.filter((run) => !seen.has(run.id))];
}

// a new filter loads a new first page, and the list mounts again with no older pages.
function RunsBody({ first, filters }: { first: RunRow[]; filters: URLSearchParams }) {
  const [older, setOlder] = useState<RunRow[]>([]);
  const [lastPageFull, setLastPageFull] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  // the server may not know a filter yet, so the page keeps only the rows of the chosen session itself.
  const sessionKey = filters.get('sessionKey');
  const rows = merge(first, older).filter((run) => !sessionKey || run.sessionKey === sessionKey);
  const more = lastPageFull ?? first.length >= PAGE_SIZE;
  const loadOlder = () => {
    const last = merge(first, older).at(-1);
    if (!last) return;
    const query = new URLSearchParams(filters);
    query.set('limit', String(PAGE_SIZE));
    query.set('before', last.id);
    setBusy(true);
    setError('');
    api<RunRow[]>(`/api/runs?${query}`).then(
      (page) => {
        setBusy(false);
        const known = new Set(merge(first, older).map((run) => run.id));
        const fresh = page.filter((run) => !known.has(run.id));
        setOlder((old) => [...old, ...fresh]);
        // a page with fewer rows than the limit is the last one. a page with no new row is the last one too.
        setLastPageFull(page.length >= PAGE_SIZE && fresh.length > 0);
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  const run = rows.find((each) => each.id === selected);
  const failed = rows.filter((each) => each.status === 'failed').length;
  const running = rows.filter((each) => each.status === 'running').length;
  return (
    <>
      <div className="runs-table">
        <Table
          label="runs"
          dense
          columns={COLUMNS}
          rows={rows}
          rowKey={(each) => each.id}
          selected={selected}
          onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
          empty={<EmptyState icon="run" title="No runs match the filters." />}
        />
      </div>
      <div className="runs-more">
        {more && rows.length ? (
          <Button variant="secondary" size="sm" busy={busy} onClick={loadOlder}>
            Load older runs
          </Button>
        ) : rows.length ? (
          <span className="muted small">No older runs.</span>
        ) : null}
        {error ? (
          <span role="alert" className="error-text">
            Could not load older runs: {error}
          </span>
        ) : null}
      </div>
      {run ? (
        <DetailsPanel title={`Run ${run.id.slice(0, 8)}`} openKey={run.id} onClose={() => setSelected(null)}>
          <RunFacts run={run} />
          <div className="dev-panel-actions">
            <ButtonLink href={runHref(run.id)} size="sm" variant="primary" icon="run">
              Open the run
            </ButtonLink>
          </div>
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Runs">
          <Facts
            layout="stacked"
            items={[
              { label: 'Shown', value: rows.length },
              { label: 'Running', value: running },
              { label: 'Failed', value: failed },
              { label: 'Cost of the shown runs', value: usd(rows.reduce((sum, each) => sum + (each.costUsd ?? 0), 0)) },
            ]}
          />
          <p className="muted small">Select a run to see its facts.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Runs({ query = new URLSearchParams() }: Partial<RouteProps>) {
  const filters = filtersOf(query);
  const first = new URLSearchParams(filters);
  first.set('limit', String(PAGE_SIZE));
  const loaded = useApi<RunRow[]>(`/api/runs?${first}`, (message) => message.kind === 'run');
  const set = (key: (typeof FILTERS)[number]) => (value: string) => setHashQuery('runs', { [key]: value });
  const sessionKey = filters.get('sessionKey');
  return (
    <Page
      title="Runs"
      width="full"
      toolbar={
        <FilterBar
          end={
            sessionKey ? (
              <Pill icon="session" className="dev-filter-pill">
                session {sessionKey}
                <IconButton icon="close" size="sm" label="Clear the session filter" onClick={() => set('sessionKey')('')} />
              </Pill>
            ) : null
          }
        >
          <Select label="trigger" value={filters.get('trigger') ?? ''} options={TRIGGERS} allLabel="all" onChange={set('trigger')} />
          <Select label="slot" value={filters.get('slot') ?? ''} options={SLOTS} allLabel="all" onChange={set('slot')} />
          <Select label="status" value={filters.get('status') ?? ''} options={STATUSES} allLabel="all" onChange={set('status')} />
          <label className={`dev-date${filters.get('day') ? ' is-set' : ''}`}>
            <span>day</span>
            <input type="date" aria-label="day" value={filters.get('day') ?? ''} onChange={(event) => set('day')(event.target.value)} />
          </label>
        </FilterBar>
      }
    >
      <Load loaded={loaded}>{(runs) => <RunsBody first={runs} filters={filters} />}</Load>
    </Page>
  );
}
