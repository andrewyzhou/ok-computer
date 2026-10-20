import { useState } from 'react';
import type { CadenceSource } from '../../../../src/dashboard/inbox-types';
import type { SubscriptionRow, SubscriptionsPage as SubscriptionsData, SubscriptionState } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { percent } from '../../format';
import type { RouteProps } from '../../routes';
import { Badge, Button, DetailsPanel, EmptyState, Facts, FilterBar, Page, Select, Skeleton, Stat, Stats, Table, type Column, type Tone } from '../../ui';
import {
  AccountBadge,
  accountColumn,
  ApprovalFor,
  Breakable,
  ConnectGoogle,
  day,
  ErrorBox,
  ExternalLink,
  LastRun,
  minuteTime,
  PendingAnswers,
  refreshInbox,
  RowNote,
  RunJob,
  StateBadge,
  money,
  setHashQuery,
  useApprovals,
  useInboxSetup,
  useRowActions,
  withQuery,
} from './shared';
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

// where the cadence comes from, in words.
export const CADENCE_SOURCE: Record<CadenceSource, string> = {
  stated: 'stated on the receipt',
  gaps: 'from the charge dates',
  both: 'stated and confirmed by the dates',
  none: 'unknown',
};

// how sure the finder is that the charge repeats, as a word and a tone: low below 0.5, medium from 0.5 to 0.8, and
// high from 0.8 up. the percent shows next to the word, so the owner sees the number that the word stands for.
export function confidenceBand(confidence: number): { label: 'low' | 'medium' | 'high'; tone: Tone } {
  if (confidence >= 0.8) return { label: 'high', tone: 'good' };
  if (confidence >= 0.5) return { label: 'medium', tone: 'info' };
  return { label: 'low', tone: 'warning' };
}

// a row that the receipts no longer support: the scan gave it confidence 0 and an unknown cadence. a row that the
// finder keeps never has confidence 0, so a doubtful row stays in view and only a stale one is hidden.
export const isStale = (row: SubscriptionRow) => row.confidence === 0 && row.cadenceSource === 'none';

export function Confidence({ value }: { value: number }) {
  const band = confidenceBand(value);
  return (
    <Badge tone={band.tone} title={`confidence ${percent(value)}`}>
      {band.label} {percent(value)}
    </Badge>
  );
}

function SubscriptionFacts({ row, approvals, onDecided }: { row: SubscriptionRow; approvals: ReturnType<typeof useApprovals>; onDecided: () => void }) {
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'State', value: <StateBadge value={row.state} tones={STATE_TONE} /> },
          { label: 'Amount', value: `${money(row.amount, row.currency)}, ${row.cadence}` },
          { label: 'Cadence', value: CADENCE_SOURCE[row.cadenceSource] ?? row.cadenceSource },
          // how sure the finder is comes right after the amount and the cadence, so it is in view without a scroll.
          { label: 'Confidence', value: <Confidence value={row.confidence} /> },
          {
            label: 'Why',
            value: row.reasons.length ? (
              <ul className="inbox-reasons" aria-label="reasons">
                {row.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            ) : (
              <span className="muted">no reasons given</span>
            ),
          },
          { label: 'Account', value: <Breakable text={row.account} /> },
          { label: 'Last charge', value: minuteTime(row.lastChargeAt) },
          { label: 'Next charge', value: minuteTime(row.nextChargeAt) },
          { label: 'Cancel link', value: row.cancelUrl ? <ExternalLink href={row.cancelUrl} /> : <span className="muted">none found</span> },
          row.browserTaskId ? { label: 'Browser task', value: <a href={`#/browser/${encodeURIComponent(row.browserTaskId)}`}>{row.browserTaskId}</a> } : null,
          { label: 'Source', value: row.sourceSubject ?? <span className="muted">no subject</span> },
          { label: 'Source message', value: <code>{row.sourceMessageId}</code> },
          // the finder tells why a row is there: how many receipts it read, and how sure it is that the charge repeats.
          { label: 'Receipts', value: `${row.sourceMessageIds.length} ${row.sourceMessageIds.length === 1 ? 'receipt' : 'receipts'}` },
          { label: 'Updated', value: minuteTime(row.updatedAt) },
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
  const setup = useInboxSetup();
  // a stale row (isStale) found no charge that repeats when its receipts were read again, so it is most likely a
  // one-time purchase. such rows are hidden until the owner asks for them. the server leaves them out of the monthly
  // totals too, with every row below confidence 0.5.
  const [showOnce, setShowOnce] = useState(false);
  // the accounts come from the rows of the first answer without a filter, so a filter does not take its own choice
  // out of the list.
  const [accounts, setAccounts] = useState<string[]>([]);
  const data = loaded.data;
  const rows = data?.subscriptions ?? [];
  const seen = [...new Set([...accounts, ...setup.accounts, ...rows.map((row) => row.account), ...(account ? [account] : [])])].sort();
  if (seen.length !== accounts.length) setAccounts(seen);
  const once = rows.filter(isStale).length;
  const shown = showOnce ? rows : rows.filter((each) => !isStale(each));
  // before the first scan the page has nothing to count, so the totals stay away.
  const scanned = data !== undefined && (data.lastScan !== null || rows.length > 0);
  const row = rows.find((each) => each.id === selected);
  const filter = (key: string) => (value: string) => setHashQuery(PATH, query, { [key]: value });
  const base = (id: number) => `/api/inbox/subscriptions/${id}`;

  // the actions show in the row on a wide screen, and in the details panel of the selected row on each screen, so a
  // phone reaches them too. a cancel that is under way cannot be ignored, so both actions show only on an active row.
  const actionsFor = (each: SubscriptionRow) => (
    <div className="inbox-actions">
      <div className="inbox-action-buttons">
        {each.state === 'active' ? (
          <Button size="sm" disabled={answers[each.id]?.busy} aria-label={`Cancel ${each.merchant}`} onClick={() => void act(each.id, `${base(each.id)}/cancel`)}>
            Cancel
          </Button>
        ) : null}
        {each.state === 'active' ? (
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
          <span className="inbox-below-md inbox-cell-badges">
            <AccountBadge account={each.account} />
            <Confidence value={each.confidence} />
          </span>
        </div>
      ),
    },
    accountColumn<SubscriptionRow>(),
    {
      key: 'amount',
      header: 'Amount',
      align: 'end',
      cell: (each) => (
        <div className="inbox-amount-cell">
          <span>{money(each.amount, each.currency)}</span>
          <span className="muted small">{each.cadence}</span>
          {each.nextChargeAt ? <span className="muted small">next {day(each.nextChargeAt)}</span> : null}
        </div>
      ),
    },
    // the next charge shows under the amount, and the last charge and the source of the cadence show in the details
    // panel, so the table has room for the account and the confidence next to the details panel.
    { key: 'confidence', header: 'Confidence', align: 'end', hideBelow: 'md', cell: (each) => <Confidence value={each.confidence} /> },
    { key: 'state', header: 'State', cell: (each) => <StateBadge value={each.state} tones={STATE_TONE} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, hideBelow: 'sm', cell: actionsFor },
  ];

  return (
    <Page
      title="Subscriptions"
      subtitle={data ? <LastRun label="scan" last={data.lastScan} /> : undefined}
      actions={<RunJob job="subscriptions" label="Scan now" note="Started. The table loads again when the scan is done." disabled={setup.state === 'missing'} />}
      toolbar={
        <FilterBar label="subscription filters">
          <Select label="account" value={account} options={accounts} allLabel="all" onChange={filter('account')} />
          <Select label="state" value={state} options={STATES} allLabel="all" onChange={filter('state')} />
          {once || showOnce ? (
            <label className="toggle">
              <input type="checkbox" checked={showOnce} onChange={(event) => setShowOnce(event.target.checked)} />
              <span>Show rows with no repeating charge</span>
              <span className="muted">({once})</span>
            </label>
          ) : null}
        </FilterBar>
      }
    >
      {loaded.error ? (
        <ErrorBox error={loaded.error} onRetry={loaded.reload} />
      ) : !data ? (
        <Skeleton lines={5} />
      ) : !scanned && !account && !state && setup.state === 'missing' ? (
        <ConnectGoogle what="The scan reads the receipts in the mail and lists the paid subscriptions." />
      ) : (
        <>
          {scanned ? (
            <Stats label="monthly totals">
              {data.monthlyTotals.length ? (
                data.monthlyTotals.map((total) => <Stat key={total.currency} label={total.currency} value={money(total.amount, total.currency)} note="estimated per month" />)
              ) : (
                <Stat label="Per month" value="-" note="no known amounts yet" />
              )}
              <Stat
                label="Subscriptions"
                value={shown.length}
                note={once && !showOnce ? `${once} with no repeating charge hidden` : account || state ? 'with these filters' : 'all found'}
              />
            </Stats>
          ) : null}
          <PendingAnswers answers={answers} rows={rows} name={(each) => each.merchant} approvals={approvals} onDecided={reload} clear={clear} />
          {/* the actions sit in the details panel too, so a narrow table drops their column and keeps the confidence in
              view. */}
          <div className="inbox-table inbox-table-drop-last">
            <Table
              label="subscriptions"
              columns={columns}
              rows={shown}
              rowKey={(each) => String(each.id)}
              selected={selected === null ? null : String(selected)}
              onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
              empty={
                <EmptyState icon="subscription" title={rows.length ? 'No repeating charges found.' : 'No subscriptions found yet.'}>
                  {rows.length
                    ? 'The scan found only charges that do not repeat. Show the rows with no repeating charge to see them.'
                    : account || state
                      ? 'No subscription matches these filters.'
                      : 'The scan reads the receipts in the mail and lists the paid subscriptions here.'}
                </EmptyState>
              }
            />
          </div>
        </>
      )}
      {row ? (
        <DetailsPanel title={row.merchant} openKey={row.id} onClose={() => setSelected(null)}>
          {row.state === 'active' ? <div className="inbox-detail-actions">{actionsFor(row)}</div> : null}
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
