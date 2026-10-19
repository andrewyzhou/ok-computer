import { useMemo, useState } from 'react';
import type { NewsletterSenderRow, SenderState, SendersPage, SendersQuery } from '../../../../src/dashboard/types';
import { api, useApi } from '../../api';
import { Empty, Load, Page, Panel } from '../../components';
import { percent, time } from '../../format';
import { ActionNotice, InboxStatus, JobLine, LoadMore, query, refreshOnInbox, Select, useAction, usePages, type Chunk } from './shared';

const STATES: readonly SenderState[] = ['active', 'kept', 'unsubscribe_pending', 'unsubscribed', 'failed'];
const SORTS: ReadonlyArray<NonNullable<SendersQuery['sort']>> = ['messages', 'readRate', 'lastAt'];

// ok computer can unsubscribe only through a one-click post or an https link. a mailto link needs a sent mail, and
// sending is off, so the owner does it by hand.
const canUnsubscribe = (sender: NewsletterSenderRow) =>
  (sender.unsubscribe.method === 'one_click' || sender.unsubscribe.method === 'https') &&
  sender.state !== 'unsubscribe_pending' &&
  sender.state !== 'unsubscribed';

function ArchiveForm({ busy, onSend, onCancel }: { busy: boolean; onSend: (days: number, label: string) => void; onCancel: () => void }) {
  const [days, setDays] = useState('30');
  const [label, setLabel] = useState('');
  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault();
        onSend(Number(days), label.trim());
      }}
    >
      <label>
        older than days
        <input type="number" min={0} max={3650} value={days} onChange={(event) => setDays(event.target.value)} />
      </label>
      <label>
        label
        <input value={label} placeholder="none" onChange={(event) => setLabel(event.target.value)} />
      </label>
      <button type="submit" disabled={busy}>
        Archive mail
      </button>
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function Unsubscribe({ sender }: { sender: NewsletterSenderRow }) {
  const { method, url } = sender.unsubscribe;
  return (
    <>
      <div>{method.replace('_', ' ')}</div>
      {/* the link comes from mail, so it shows as text and is never an anchor. */}
      {url ? <code className="wrap small">{url}</code> : null}
      {method === 'mailto' ? (
        <div className="muted small">Unsubscribe by hand with this address, because ok computer does not send mail.</div>
      ) : null}
    </>
  );
}

export function Newsletters() {
  const [filter, setFilter] = useState({ account: '', state: '', sort: '' });
  const [archiving, setArchiving] = useState<number | null>(null);
  const base = `/api/inbox/senders${query(filter)}`;
  const loaded = useApi<SendersPage>(base, refreshOnInbox);
  const first = useMemo<Chunk<NewsletterSenderRow> | undefined>(
    () => (loaded.data ? { rows: loaded.data.senders, next: loaded.data.nextCursor } : undefined),
    [loaded.data],
  );
  const pages = usePages(first, (cursor) =>
    api<SendersPage>(`/api/inbox/senders${query({ ...filter, cursor })}`).then((page) => ({ rows: page.senders, next: page.nextCursor })),
  );
  const action = useAction(loaded.reload);
  const path = (sender: NewsletterSenderRow, verb: string) => `/api/inbox/senders/${sender.id}/${verb}`;
  const accounts = loaded.data?.accounts ?? (filter.account ? [filter.account] : []);
  return (
    <Page title="Newsletters">
      <JobLine
        label="Last sweep"
        last={loaded.data?.lastSweep ?? null}
        button="Sweep now"
        busy={action.busy}
        onRun={() => void action.runJob('newsletters', 'The sweep runs now. The list updates when it ends.')}
      />
      <ActionNotice notice={action.notice} />
      <div className="filters">
        <Select label="account" value={filter.account} options={accounts} onChange={(account) => setFilter({ ...filter, account })} />
        <Select label="state" value={filter.state} options={STATES} onChange={(state) => setFilter({ ...filter, state })} />
        <label>
          sort
          <select value={filter.sort} onChange={(event) => setFilter({ ...filter, sort: event.target.value })}>
            <option value="">messages</option>
            {SORTS.slice(1).map((sort) => (
              <option key={sort}>{sort}</option>
            ))}
          </select>
        </label>
      </div>
      <Panel title="Senders">
        <Load loaded={loaded}>
          {() =>
            pages.rows.length ? (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Sender</th>
                      <th>Key</th>
                      <th className="num">Messages</th>
                      <th className="num">Read</th>
                      <th>Last mail</th>
                      <th>Unsubscribe</th>
                      <th>State</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pages.rows.map((sender) => (
                      <tr key={sender.id}>
                        <td className="wrap">
                          <strong>{sender.displayName ?? sender.fromAddress}</strong>
                          <div className="muted small">
                            {sender.fromAddress} · {sender.account}
                          </div>
                        </td>
                        <td className="wrap">
                          <code>{sender.senderKey}</code>
                        </td>
                        <td className="num">{sender.messages}</td>
                        <td className="num">{percent(sender.readRate)}</td>
                        <td>{time(sender.lastAt)}</td>
                        <td className="wrap">
                          <Unsubscribe sender={sender} />
                        </td>
                        <td className="wrap">
                          <InboxStatus value={sender.state} />
                          {sender.state === 'unsubscribe_pending' && sender.approvalId !== null ? (
                            <div>
                              <a href="#/approvals">approval #{sender.approvalId}</a>
                            </div>
                          ) : null}
                          {sender.archived ? (
                            <div className="muted small">
                              {sender.archived} archived{sender.label ? ` with label ${sender.label}` : ''}
                            </div>
                          ) : null}
                          {sender.error ? <div className="error-text small">{sender.error}</div> : null}
                        </td>
                        <td>
                          <div className="row">
                            <button
                              type="button"
                              disabled={action.busy || !canUnsubscribe(sender)}
                              onClick={() => void action.act(path(sender, 'unsubscribe'), {})}
                            >
                              Unsubscribe
                            </button>
                            <button type="button" className="secondary" disabled={action.busy} onClick={() => setArchiving(sender.id)}>
                              Archive
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={action.busy || sender.state === 'kept'}
                              onClick={() => void action.act(path(sender, 'keep'), {})}
                            >
                              Keep
                            </button>
                          </div>
                          {archiving === sender.id ? (
                            <ArchiveForm
                              busy={action.busy}
                              onCancel={() => setArchiving(null)}
                              onSend={(olderThanDays, label) =>
                                void action
                                  .act(path(sender, 'archive'), label ? { olderThanDays, label } : { olderThanDays })
                                  .then(() => setArchiving(null))
                              }
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <LoadMore pages={pages} />
              </>
            ) : (
              <Empty>No senders match the filters. A sweep finds them in the mail.</Empty>
            )
          }
        </Load>
      </Panel>
    </Page>
  );
}
