import { useState } from 'react';
import type { SubscriptionRow, SubscriptionsPage as SubscriptionsData, SubscriptionState } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { time } from '../../format';
import type { RouteProps } from '../../routes';
import { Button, DetailsPanel, EmptyState, Facts, FilterBar, Page, Select, Skeleton, Stat, Stats, Table, type Column, type Tone } from '../../ui';
import { ApprovalFor, day, ExternalLink, LastRun, PendingAnswers, refreshInbox, RowNote, RunJob, StateBadge, money, setHashQuery, useApprovals, useRowActions, withQuery } from './shared';
import './inbox.css';

// the paid subscriptions that the scan found in the receipts. cancel waits for the owner's approval, and each step of
// it is approved too. ignore takes a row out of the totals.

const PATH = 'inbox/subscriptions';

const STATES: Array<{ value: SubscriptionState; label: string }> = [
  { value: 'active', label: 'active' },
  { value: 'cancel_pending', label: 'cancel pending' },
  { value: 'cancelled', label: 'cancelled' },
  { value: 'ignored', label: 'ignored' },
];

const STATE_TONE: Record<SubscriptionState, Tone> = { active: 'info', cancel_pending: 'warning', cancelled: 'good', ignored: 'muted' };

function SubscriptionFacts({ row, approvals, onDecided }: { row: SubscriptionRow; approvals: ReturnType<typeof useApprovals>; onDecided: () => void }) {
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'State', value: <StateBadge value={row.state} tones={STATE_TONE} /> },
          { label: 'Account', value: row.account },
          { label: 'Amount', value: `${money(row.amount, row.currency)}, ${row.cadence}` },
          { label: 'Last charge', value: time(row.lastChargeAt) },
          { label: 'Next charge', value: time(row.nextChargeAt) },
          { label: 'Cancel link', value: row.cancelUrl ? <ExternalLink href={row.cancelUrl} /> : <span className="muted">none found</span> },
          row.browserTaskId ? { label: 'Browser task', value: <a href={`#/browser/${encodeURIComponent(row.browserTaskId)}`}>{row.browserTaskId}</a> } : null,
          { label: 'Source', value: row.sourceSubject ?? <span className="muted">no subject</span> },
          { label: 'Source message', value: <code>{row.sourceMessageId}</code> },
          { label: 'Updated', value: time(row.updatedAt) },
        ]}
      />
      {row.approvalId !== null ? (
        <div className="inbox-detail-approval">
          <h3 className="inbox-subhead">Approval</h3>
          <ApprovalFor id={row.approvalId} approvals={approvals} onDecided={onDecided} />
        </div>
      ) : null}
    </>
  );
}

export function SubscriptionsPage({ query }: RouteProps) {
  const account = query.get('account') ?? '';
  const state = query.get('state') ?? '';
  const loaded = useApi<SubscriptionsData>(withQuery('/api/inbox/subscriptions', { account, state }), refreshInbox);
  const approvals = useApprovals();
  const reload = () => {
    loaded.reload();
    approvals.reload();
  };
  const { answers, act, clear } = useRowActions(reload);
  const [selected, setSelected] = useState<number | null>(null);
  // the accounts come from the rows of the first answer without a filter, so a filter does not take its own choice
  // out of the list.
  const [accounts, setAccounts] = useState<string[]>([]);
  const data = loaded.data;
  const rows = data?.subscriptions ?? [];
  const seen = [...new Set([...accounts, ...rows.map((row) => row.account), ...(account ? [account] : [])])].sort();
  if (seen.length !== accounts.length) setAccounts(seen);
  const row = rows.find((each) => each.id === selected);
  const filter = (key: string) => (value: string) => setHashQuery(PATH, query, { [key]: value });
  const base = (id: number) => `/api/inbox/subscriptions/${id}`;

  // the actions show in the row on a wide screen, and in the details panel of the selected row on each screen, so a
  // phone reaches them too.
  const actionsFor = (each: SubscriptionRow) => (
    <div className="inbox-actions">
      <div className="inbox-action-buttons">
        {each.state === 'active' ? (
          <Button size="sm" disabled={answers[each.id]?.busy} aria-label={`Cancel ${each.merchant}`} onClick={() => void act(each.id, `${base(each.id)}/cancel`)}>
            Cancel
          </Button>
        ) : null}
        {each.state !== 'ignored' && each.state !== 'cancelled' ? (
          <Button size="sm" variant="ghost" disabled={answers[each.id]?.busy} aria-label={`Ignore ${each.merchant}`} onClick={() => void act(each.id, `${base(each.id)}/ignore`)}>
            Ignore
          </Button>
        ) : null}
      </div>
      <RowNote answer={answers[each.id]} />
    </div>
  );

  const columns: Array<Column<SubscriptionRow>> = [
    {
      key: 'merchant',
      header: 'Merchant',
      wrap: true,
      cell: (each) => (
        <div className="inbox-name">
          <span>{each.merchant}</span>
          {each.sourceSubject ? <span className="muted small">{each.sourceSubject}</span> : null}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'end',
      cell: (each) => (
        <div className="inbox-amount-cell">
          <span>{money(each.amount, each.currency)}</span>
          <span className="muted small">{each.cadence}</span>
        </div>
      ),
    },
    { key: 'last', header: 'Last charge', hideBelow: 'md', cell: (each) => <span className="inbox-nowrap">{day(each.lastChargeAt)}</span> },
    { key: 'next', header: 'Next charge', hideBelow: 'sm', cell: (each) => <span className="inbox-nowrap">{day(each.nextChargeAt)}</span> },
    { key: 'state', header: 'State', cell: (each) => <StateBadge value={each.state} tones={STATE_TONE} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, hideBelow: 'sm', cell: actionsFor },
  ];

  return (
    <Page
      title="Subscriptions"
      subtitle={data ? <LastRun label="scan" last={data.lastScan} /> : undefined}
      actions={<RunJob job="subscriptions" label="Scan now" note="Started. The table loads again when the scan is done." />}
      toolbar={
        <FilterBar label="subscription filters">
          <Select label="account" value={account} options={accounts} allLabel="all" onChange={filter('account')} />
          <Select label="state" value={state} options={STATES} allLabel="all" onChange={filter('state')} />
        </FilterBar>
      }
    >
      {loaded.error ? (
        <p className="error-box">Could not load: {loaded.error}</p>
      ) : !data ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <Stats label="monthly totals">
            {data.monthlyTotals.length ? (
              data.monthlyTotals.map((total) => <Stat key={total.currency} label={total.currency} value={money(total.amount, total.currency)} note="estimated per month" />)
            ) : (
              <Stat label="Per month" value="-" note="no known amounts yet" />
            )}
            <Stat label="Subscriptions" value={rows.length} note={account || state ? 'with these filters' : 'all found'} />
          </Stats>
          <PendingAnswers answers={answers} rows={rows} name={(each) => each.merchant} approvals={approvals} onDecided={reload} clear={clear} />
          <Table
            label="subscriptions"
            columns={columns}
            rows={rows}
            rowKey={(each) => String(each.id)}
            selected={selected === null ? null : String(selected)}
            onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
            empty={
              <EmptyState icon="subscription" title="No subscriptions found yet.">
                {account || state ? 'No subscription matches these filters.' : 'The scan reads the receipts in the mail and lists the paid subscriptions here.'}
              </EmptyState>
            }
          />
        </>
      )}
      {row ? (
        <DetailsPanel title={row.merchant} openKey={row.id} onClose={() => setSelected(null)}>
          {row.state === 'active' || row.state === 'cancel_pending' ? <div className="inbox-detail-actions">{actionsFor(row)}</div> : null}
          <SubscriptionFacts row={row} approvals={approvals} onDecided={reload} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Subscriptions">
          <p className="muted">Select a subscription to see its cancel link, its approval and the receipt it came from.</p>
        </DetailsPanel>
      )}
    </Page>
  );
}
