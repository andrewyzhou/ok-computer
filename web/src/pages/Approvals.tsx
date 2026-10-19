import { useState } from 'react';
import type { ApprovalRow, StreamMessage } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Expand, Json, Load } from '../components';
import { time } from '../format';
import { ApprovalCard, ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, Page, Status, Table, Tabs, type Column } from '../ui';
import './agent.css';

type Tab = 'pending' | 'history';

// an approval can be resolved in another place, for example in a chat, so the page loads again on each approval and
// run message of the stream.
const refreshOn = (message: StreamMessage) => message.kind === 'approval' || message.kind === 'run';

const COLUMNS: Array<Column<ApprovalRow>> = [
  { key: 'id', header: 'Id', cell: (approval) => `#${approval.id}` },
  { key: 'tool', header: 'Tool', cell: (approval) => approval.toolName },
  {
    key: 'summary',
    header: 'Summary',
    cell: (approval) => approval.summary,
    wrap: true,
    hideBelow: 'sm',
  },
  {
    key: 'status',
    header: 'Status',
    cell: (approval) => <Status value={approval.status} />,
  },
  {
    key: 'requested',
    header: 'Requested',
    cell: (approval) => time(approval.requestedAt),
    hideBelow: 'md',
  },
  {
    key: 'resolved',
    header: 'Resolved',
    hideBelow: 'sm',
    cell: (approval) => (
      <>
        {time(approval.resolvedAt)} {approval.resolvedBy ? <span className="muted">by {approval.resolvedBy}</span> : null}
      </>
    ),
  },
];

function ApprovalDetails({ approval, onClose }: { approval: ApprovalRow; onClose: () => void }) {
  return (
    <DetailsPanel title={`Approval #${approval.id}`} openKey={approval.id} onClose={onClose}>
      <Facts
        layout="stacked"
        items={[
          { label: 'Tool', value: approval.toolName },
          { label: 'Status', value: <Status value={approval.status} /> },
          {
            label: 'Summary',
            value: <span className="approvals-summary">{approval.summary}</span>,
          },
          { label: 'Requested', value: time(approval.requestedAt) },
          {
            label: 'Resolved',
            value: approval.resolvedAt ? time(approval.resolvedAt) : 'not yet',
          },
          approval.resolvedBy !== null && {
            label: 'Resolved by',
            value: approval.resolvedBy,
          },
          { label: 'Session', value: <code>{approval.sessionKey}</code> },
        ]}
      />
      <Expand label="full input">{() => <Json value={approval.input} />}</Expand>
      <div>
        <ButtonLink href={`#/runs/${encodeURIComponent(approval.runId)}`} size="sm" icon="run">
          Open run {approval.runId.slice(0, 8)}
        </ButtonLink>
      </div>
    </DetailsPanel>
  );
}

function ApprovalsBody({ approvals, tab, onDecided }: { approvals: ApprovalRow[]; tab: Tab; onDecided: (message: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const history = approvals.filter((approval) => approval.status !== 'pending');
  const chosen = tab === 'history' ? history.find((approval) => String(approval.id) === selected) : undefined;
  return (
    <>
      {tab === 'pending' ? (
        pending.length ? (
          <ul className="approvals-list" aria-label="pending approvals">
            {pending.map((approval) => (
              <li key={approval.id}>
                <ApprovalCard approval={approval} onDecided={onDecided} />
                <div className="approvals-input">
                  <Expand label="full input">{() => <Json value={approval.input} />}</Expand>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="approval" title="Nothing waits for your approval.">
            A tool call that needs your decision shows here, and in the chat that asked for it.
          </EmptyState>
        )
      ) : (
        <Table
          label="resolved approvals"
          columns={COLUMNS}
          rows={history}
          rowKey={(approval) => String(approval.id)}
          selected={selected}
          onSelect={(approval) => setSelected(String(approval.id) === selected ? null : String(approval.id))}
          empty={<EmptyState icon="approval" title="No resolved approvals yet." />}
        />
      )}
      {chosen ? (
        <ApprovalDetails approval={chosen} onClose={() => setSelected(null)} />
      ) : (
        <DetailsPanel title="Approvals">
          <Facts
            layout="stacked"
            items={[
              { label: 'Waiting', value: pending.length },
              {
                label: 'Approved',
                value: history.filter((approval) => approval.status === 'approved').length,
              },
              {
                label: 'Denied',
                value: history.filter((approval) => approval.status === 'denied').length,
              },
              {
                label: 'Expired',
                value: history.filter((approval) => approval.status === 'expired').length,
              },
            ]}
          />
          {tab === 'history' ? <p className="muted small">Select an approval to see its full input.</p> : null}
        </DetailsPanel>
      )}
    </>
  );
}

export function Approvals({ query }: { query?: URLSearchParams }) {
  const loaded = useApi<ApprovalRow[]>('/api/approvals', refreshOn);
  const [notice, setNotice] = useState('');
  const tab: Tab = query?.get('tab') === 'history' ? 'history' : 'pending';
  // the tab lives in the hash, so a reload or a shared link keeps it.
  const setTab = (next: Tab) => {
    location.hash = next === 'history' ? '#/approvals?tab=history' : '#/approvals';
  };
  const pendingCount = loaded.data?.filter((approval) => approval.status === 'pending').length ?? 0;
  return (
    <Page
      title="Approvals"
      subtitle="The tool calls that wait for your decision, and the ones you decided."
      actions={
        notice ? (
          <span className="muted" role="status">
            {notice}
          </span>
        ) : undefined
      }
      toolbar={
        <FilterBar>
          <Tabs
            label="approvals"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'pending', label: 'Pending', count: pendingCount },
              { id: 'history', label: 'History' },
            ]}
          />
        </FilterBar>
      }
    >
      <Load loaded={loaded}>
        {(approvals) => (
          <ApprovalsBody
            approvals={approvals}
            tab={tab}
            onDecided={(message) => {
              setNotice(message);
              loaded.reload();
            }}
          />
        )}
      </Load>
    </Page>
  );
}
