import { useState, type FormEvent } from 'react';
import type { NewsletterSenderRow, SenderState, SendersPage, UnsubscribeMethod } from '../../../../src/dashboard/types';
import { percent, time } from '../../format';
import type { RouteProps } from '../../routes';
import { Button, DetailsPanel, Drawer, EmptyState, Facts, FilterBar, IconButton, Page, Select, Skeleton, Table, type Column, type Tone } from '../../ui';
import {
  day,
  LastRun,
  LoadMore,
  PendingAnswers,
  RowNote,
  RunJob,
  StateBadge,
  setHashQuery,
  useApprovals,
  usePaged,
  useRowActions,
  withQuery,
  type RowAnswer,
} from './shared';
import './inbox.css';

// the senders of the newsletter sweep, with the actions on each: unsubscribe, archive the old mail, or keep the
// sender out of later sweeps. unsubscribe and archive change mail, so they wait for the owner's approval.

const PATH = 'inbox/newsletters';

const STATES: Array<{ value: SenderState; label: string }> = [
  { value: 'active', label: 'active' },
  { value: 'kept', label: 'kept' },
  { value: 'unsubscribe_pending', label: 'unsubscribe pending' },
  { value: 'unsubscribed', label: 'unsubscribed' },
  { value: 'failed', label: 'failed' },
];

const STATE_TONE: Record<SenderState, Tone> = {
  active: 'muted',
  kept: 'info',
  unsubscribe_pending: 'warning',
  unsubscribed: 'good',
  failed: 'critical',
};

const SORTS = [
  { value: 'messages', label: 'most mail' },
  { value: 'readRate', label: 'read rate' },
  { value: 'lastAt', label: 'last mail' },
];

const METHOD: Record<UnsubscribeMethod, string> = { one_click: 'one click', https: 'link', mailto: 'mail', none: 'none' };

const senderName = (sender: NewsletterSenderRow) => sender.displayName ?? sender.fromAddress;

// the reason that the unsubscribe button is off, or null when it is on. the button says it in its title.
export function unsubscribeBlock(sender: NewsletterSenderRow): string | null {
  if (sender.state === 'unsubscribed') return 'This sender is already unsubscribed.';
  if (sender.state === 'unsubscribe_pending') return 'The unsubscribe waits for your approval.';
  if (sender.unsubscribe.method === 'none') return 'The mail of this sender has no unsubscribe link.';
  // ok computer never sends mail, so a mail unsubscribe is only shown. the owner does it by hand.
  if (sender.unsubscribe.method === 'mailto') return 'This sender unsubscribes by mail, and ok computer never sends mail. Unsubscribe by hand with the address in the details.';
  if (!sender.unsubscribe.url) return 'This sender gives no unsubscribe link. Unsubscribe by hand in its mail.';
  return null;
}

// the reason that the keep button is off, or null when it is on. a keep would hide the record of an unsubscribe.
export function keepBlock(sender: NewsletterSenderRow): string | null {
  if (sender.state === 'kept') return 'This sender is already kept.';
  if (sender.state === 'unsubscribe_pending') return 'The unsubscribe of this sender is under way, so it cannot be kept now.';
  if (sender.state === 'unsubscribed') return 'This sender is unsubscribed, so it cannot be kept.';
  return null;
}

function ArchiveForm({
  sender,
  error,
  onClose,
  onArchive,
}: {
  sender: NewsletterSenderRow;
  error: string | undefined;
  onClose: () => void;
  onArchive: (body: { olderThanDays: number; label?: string }) => Promise<boolean> }) {
  const [days, setDays] = useState('30');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const value = Number(days);
  const valid = days.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 3650;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    void onArchive({ olderThanDays: value, ...(label.trim() ? { label: label.trim() } : {}) }).then((ok) => {
      setBusy(false);
      if (ok) onClose();
    });
  };
  return (
    <form className="inbox-form" onSubmit={submit} aria-label={`archive the mail of ${senderName(sender)}`}>
      <header className="inbox-form-head">
        <h2 className="details-title">Archive the mail of {senderName(sender)}</h2>
        <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
      </header>
      <p className="muted">The mail leaves the inbox after you approve it. Nothing is deleted.</p>
      <label className="inbox-field">
        <span>Older than (days)</span>
        <input
          type="number"
          min={0}
          max={3650}
          step={1}
          value={days}
          onChange={(event) => setDays(event.target.value)}
          aria-invalid={!valid}
          aria-describedby="inbox-days-help"
          data-autofocus
        />
        <span id="inbox-days-help" className={valid ? 'muted small' : 'error-text small'}>
          A whole number from 0 to 3650. 0 archives all of the mail.
        </span>
      </label>
      <label className="inbox-field">
        <span>Label (optional)</span>
        <input type="text" value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} placeholder="for example newsletters" />
      </label>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      <div className="inbox-form-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!valid}>
          Archive
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SenderActions({
  sender,
  answer,
  onUnsubscribe,
  onArchive,
  onKeep,
}: {
  sender: NewsletterSenderRow;
  answer: RowAnswer | undefined;
  onUnsubscribe: () => void;
  onArchive: () => void;
  onKeep: () => void;
}) {
  const block = unsubscribeBlock(sender);
  const keepOff = keepBlock(sender);
  const name = senderName(sender);
  return (
    <div className="inbox-actions">
      <div className="inbox-action-buttons">
        <Button
          size="sm"
          disabled={block !== null || answer?.busy}
          title={block ?? `Unsubscribe from ${name}`}
          aria-label={`Unsubscribe from ${name}`}
          onClick={onUnsubscribe}
        >
          Unsubscribe
        </Button>
        <Button size="sm" variant="ghost" disabled={answer?.busy} aria-label={`Archive the mail of ${name}`} onClick={onArchive}>
          Archive
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={keepOff !== null || answer?.busy}
          title={keepOff ?? `Keep ${name} out of later sweeps`}
          aria-label={`Keep ${name}`}
          onClick={onKeep}
        >
          Keep
        </Button>
      </div>
      <RowNote answer={answer} />
    </div>
  );
}

function SenderFacts({ sender }: { sender: NewsletterSenderRow }) {
  return (
    <Facts
      layout="stacked"
      items={[
        { label: 'State', value: <StateBadge value={sender.state} tones={STATE_TONE} /> },
        { label: 'Account', value: sender.account },
        { label: 'List-Id', value: sender.listId ?? <span className="muted">none</span> },
        { label: 'From', value: sender.fromAddress },
        { label: 'Mail', value: `${sender.messages} messages, ${sender.read} read (${percent(sender.readRate)})` },
        { label: 'First and last', value: `${time(sender.firstAt)} to ${time(sender.lastAt)}` },
        { label: 'Unsubscribe', value: METHOD[sender.unsubscribe.method] },
        // the unsubscribe goes only through the approved action, so its link shows as text and is never an anchor that
        // could unsubscribe with one press.
        sender.unsubscribe.url ? { label: 'Unsubscribe link', value: <code className="inbox-external">{sender.unsubscribe.url}</code> } : null,
        { label: 'Archived', value: sender.archived },
        { label: 'Label', value: sender.label ?? <span className="muted">none</span> },
        sender.approvalId !== null ? { label: 'Approval', value: <a href="#/approvals">#{sender.approvalId}</a> } : null,
        { label: 'Unsubscribed', value: time(sender.unsubscribedAt) },
        sender.error ? { label: 'Error', value: <span className="error-text">{sender.error}</span> } : null,
      ]}
    />
  );
}

export function NewslettersPage({ query }: RouteProps) {
  const account = query.get('account') ?? '';
  const state = query.get('state') ?? '';
  const sort = query.get('sort') ?? 'messages';
  const filters = { account, state, sort: sort === 'messages' ? '' : sort };
  const paged = usePaged<SendersPage>(withQuery('/api/inbox/senders', filters), (last) =>
    last.nextCursor ? withQuery('/api/inbox/senders', { ...filters, cursor: last.nextCursor }) : null,
  );
  const approvals = useApprovals();
  const reload = () => {
    paged.reload();
    approvals.reload();
  };
  const { answers, act, clear } = useRowActions(reload);
  const [selected, setSelected] = useState<number | null>(null);
  const [archiving, setArchiving] = useState<number | null>(null);
  const first = paged.pages[0];
  // the accounts stay in the select while a new filter loads, so a second choice does not find an empty list.
  const [accounts, setAccounts] = useState<string[]>([]);
  const known = first ? [...new Set([...first.accounts, ...(account ? [account] : [])])] : accounts;
  if (known.join() !== accounts.join()) setAccounts(known);
  const senders = paged.pages.flatMap((page) => page.senders);
  const sender = senders.find((each) => each.id === selected);
  const archiveSender = senders.find((each) => each.id === archiving);
  const filter = (key: string) => (value: string) => setHashQuery(PATH, query, { [key]: value });
  const base = (id: number) => `/api/inbox/senders/${id}`;

  // the actions show in the row on a wide screen. on a phone the row has no room for them, so they show in the details
  // panel of the selected sender, which is there on each screen.
  const actionsFor = (row: NewsletterSenderRow) => (
    <SenderActions
      sender={row}
      answer={answers[row.id]}
      onUnsubscribe={() => void act(row.id, `${base(row.id)}/unsubscribe`)}
      onArchive={() => {
        clear(row.id);
        setArchiving(row.id);
      }}
      onKeep={() => void act(row.id, `${base(row.id)}/keep`)}
    />
  );

  const columns: Array<Column<NewsletterSenderRow>> = [
    {
      key: 'sender',
      header: 'Sender',
      wrap: true,
      cell: (row) => (
        <div className="inbox-name">
          <span>{senderName(row)}</span>
          {row.listId ? <span className="muted small">{row.listId}</span> : null}
        </div>
      ),
    },
    { key: 'messages', header: 'Messages', align: 'end', cell: (row) => row.messages },
    { key: 'read', header: 'Read', align: 'end', hideBelow: 'sm', cell: (row) => percent(row.readRate) },
    { key: 'last', header: 'Last', hideBelow: 'md', cell: (row) => <span className="inbox-nowrap">{day(row.lastAt)}</span> },
    {
      key: 'state',
      header: 'State',
      cell: (row) => (
        <div className="inbox-state">
          <StateBadge value={row.state} tones={STATE_TONE} />
          <span className="muted small">unsubscribe: {METHOD[row.unsubscribe.method]}</span>
        </div>
      ),
    },
    { key: 'actions', header: <span className="sr-only">Actions</span>, hideBelow: 'sm', cell: (row) => actionsFor(row) },
  ];

  return (
    <Page
      title="Newsletters"
      subtitle={first ? <LastRun label="sweep" last={first.lastSweep} /> : undefined}
      actions={<RunJob job="newsletters" label="Sweep now" note="Started. The list loads again when the sweep is done." />}
      toolbar={
        <FilterBar label="newsletter filters">
          <Select label="account" value={account} options={known.length ? known : account ? [account] : []} allLabel="all" onChange={filter('account')} />
          <Select label="state" value={state} options={STATES} allLabel="all" onChange={filter('state')} />
          <Select label="sort" value={sort} options={SORTS} onChange={(value) => setHashQuery(PATH, query, { sort: value === 'messages' ? null : value })} />
        </FilterBar>
      }
    >
      {paged.error ? (
        <p className="error-box">Could not load: {paged.error}</p>
      ) : !first ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <PendingAnswers answers={answers} rows={senders} name={senderName} approvals={approvals} onDecided={reload} clear={clear} />
          <Table
            label="newsletter senders"
            columns={columns}
            rows={senders}
            rowKey={(row) => String(row.id)}
            selected={selected === null ? null : String(selected)}
            onSelect={(row) => setSelected(row.id === selected ? null : row.id)}
            empty={
              <EmptyState icon="mail" title="No newsletters found yet.">
                {account || state ? 'No sender matches these filters.' : 'The sweep runs each week and lists the senders of bulk mail here. Sweep now to start it.'}
              </EmptyState>
            }
          />
          <LoadMore paged={paged} />
        </>
      )}
      {sender ? (
        <DetailsPanel title={senderName(sender)} openKey={sender.id} onClose={() => setSelected(null)}>
          <div className="inbox-detail-actions">{actionsFor(sender)}</div>
          <SenderFacts sender={sender} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Newsletters">
          <p className="muted">Select a sender to see its List-Id, its unsubscribe link and what the sweep did.</p>
        </DetailsPanel>
      )}
      <Drawer open={archiveSender !== undefined} onClose={() => setArchiving(null)} label="Archive mail">
        {archiveSender ? (
          <ArchiveForm
            sender={archiveSender}
            error={answers[archiveSender.id]?.error}
            onClose={() => setArchiving(null)} onArchive={(body) => act(archiveSender.id, `${base(archiveSender.id)}/archive`, body)} />
        ) : null}
      </Drawer>
    </Page>
  );
}
