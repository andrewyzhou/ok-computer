import { useState } from 'react';
import type { SignalRow } from '../../../src/dashboard/google-types';
import { useApi } from '../api';
import { Load } from '../components';
import { time } from '../format';
import { DetailsPanel, EmptyState, Facts, FilterBar, Page, Select, Status, Table, type Column } from '../ui';
import './agent.css';

const HANDLED: Record<string, string> = {
  notified: 'the heartbeat told the owner',
  seen: 'the heartbeat read it and stayed silent',
  filtered: 'left out: a quiet label and no detector hit',
  stale: 'no heartbeat handled it in 3 days',
};

// a signal that no heartbeat handled yet has no handledAs. the filter calls it waiting, as the table does.
const handledOf = (signal: SignalRow): string => signal.handledAs ?? 'waiting';

function LabelCell({ signal }: { signal: SignalRow }) {
  return (
    <>
      {signal.label ? <Status value={signal.label} /> : signal.source === 'gmail' ? <span className="muted">no label yet</span> : null}
      {signal.labelModelCallId !== null && signal.runId ? (
        <a href={`#/runs/${encodeURIComponent(signal.runId)}`} className="signals-call">
          model call {signal.labelModelCallId}
        </a>
      ) : null}
      {signal.detectors?.length ? (
        <ul className="signals-detectors" aria-label="detector hits">
          {signal.detectors.map((hit, index) => (
            <li key={index}>
              <strong>{hit.name}</strong>: {hit.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function HandledCell({ signal }: { signal: SignalRow }) {
  if (!signal.handledAs)
    return (
      <>
        <Status value="waiting" /> waits for the next heartbeat
      </>
    );
  return (
    <>
      <Status value={signal.handledAs} /> {HANDLED[signal.handledAs]}
      {signal.handledBy && signal.handledBy !== 'reset' ? (
        <>
          {' '}
          in <a href={`#/runs/${encodeURIComponent(signal.handledBy)}`}>run {signal.handledBy.slice(0, 8)}</a>
        </>
      ) : null}
      {signal.notification ? <div className="signals-quote">“{signal.notification}”</div> : null}
    </>
  );
}

const COLUMNS: Array<Column<SignalRow>> = [
  {
    key: 'seen',
    header: 'Seen',
    hideBelow: 'md',
    cell: (signal) => (
      <>
        <span className="signals-id">#{signal.id}</span>
        <span className="signals-seen">{time(signal.seenAt)}</span>
      </>
    ),
  },
  {
    key: 'from',
    header: 'From',
    hideBelow: 'sm',
    cell: (signal) => (
      <>
        {signal.source}:{signal.account}
        <div className="muted small">{signal.kind.replace('_', ' ')}</div>
      </>
    ),
  },
  {
    key: 'signal',
    header: 'Signal',
    cell: (signal) => signal.summary,
    width: '28%',
    wrap: true,
  },
  {
    key: 'label',
    header: 'Label and detectors',
    cell: (signal) => <LabelCell signal={signal} />,
    wrap: true,
    hideBelow: 'sm',
  },
  {
    key: 'handled',
    header: 'What happened',
    cell: (signal) => <HandledCell signal={signal} />,
    wrap: true,
  },
];

function SignalDetails({ signal, onClose }: { signal: SignalRow; onClose: () => void }) {
  return (
    <DetailsPanel title={`Signal #${signal.id}`} openKey={signal.id} onClose={onClose}>
      <Facts
        layout="stacked"
        items={[
          {
            label: 'Signal',
            value: signal.summary ?? <span className="muted">no summary</span>,
          },
          { label: 'From', value: `${signal.source}:${signal.account}` },
          { label: 'Kind', value: signal.kind.replace('_', ' ') },
          { label: 'State', value: signal.state },
          signal.occursAt !== null && {
            label: 'Occurs',
            value: time(signal.occursAt),
          },
          { label: 'Seen', value: time(signal.seenAt) },
          {
            label: 'Label and detectors',
            value: <LabelCell signal={signal} />,
          },
          { label: 'What happened', value: <HandledCell signal={signal} /> },
          signal.handledAt !== null && {
            label: 'Handled',
            value: time(signal.handledAt),
          },
          signal.runId !== null && {
            label: 'Run',
            value: <a href={`#/runs/${encodeURIComponent(signal.runId)}`}>run {signal.runId.slice(0, 8)}</a>,
          },
        ]}
      />
    </DetailsPanel>
  );
}

function SignalsBody({ signals, source, handled }: { signals: SignalRow[]; source: string; handled: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!signals.length) return <EmptyState icon="signal" title="No signals yet. A poll makes them from new mail and calendar changes." />;
  const shown = signals.filter((signal) => (!source || signal.source === source) && (!handled || handledOf(signal) === handled));
  const signal = signals.find((each) => String(each.id) === selected);
  return (
    <>
      <Table
        label="signals"
        columns={COLUMNS}
        rows={shown}
        rowKey={(each) => String(each.id)}
        selected={selected}
        onSelect={(each) => setSelected(String(each.id) === selected ? null : String(each.id))}
        empty={<EmptyState icon="filter" title="No signal matches these filters." />}
      />
      {signal ? (
        <SignalDetails signal={signal} onClose={() => setSelected(null)} />
      ) : (
        <DetailsPanel title="Signals">
          <Facts
            layout="stacked"
            items={['notified', 'seen', 'filtered', 'stale', 'waiting'].map((each) => ({
              label: <Status value={each} />,
              value: signals.filter((one) => handledOf(one) === each).length,
            }))}
          />
          <p className="muted small">Select a signal to see all its fields.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Signals() {
  const loaded = useApi<SignalRow[]>('/api/signals', (message) => message.kind === 'run');
  const [source, setSource] = useState('');
  const [handled, setHandled] = useState('');
  const sources = [...new Set((loaded.data ?? []).map((signal) => signal.source))].sort();
  return (
    <Page
      title="Signals"
      subtitle="New mail and calendar changes, and what the heartbeat did with each."
      toolbar={
        loaded.data?.length ? (
          <FilterBar>
            <Select label="source" value={source} options={sources} onChange={setSource} allLabel="all" />
            <Select
              label="handled"
              value={handled}
              options={['notified', 'seen', 'filtered', 'stale', 'waiting']}
              onChange={setHandled}
              allLabel="all"
            />
          </FilterBar>
        ) : undefined
      }
    >
      <Load loaded={loaded}>{(signals) => <SignalsBody signals={signals} source={source} handled={handled} />}</Load>
    </Page>
  );
}
