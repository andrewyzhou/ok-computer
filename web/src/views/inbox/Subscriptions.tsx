import { useState } from 'react';
import type { SubscriptionRow, SubscriptionsPage, SubscriptionState } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { Empty, Load, Page, Panel, Tile } from '../../components';
import { percent, time } from '../../format';
import { ActionNotice, InboxStatus, JobLine, money, query, refreshOnInbox, Select, useAction } from './shared';

const STATES: readonly SubscriptionState[] = ['active', 'cancel_pending', 'cancelled', 'ignored'];

export function Subscriptions() {
  const [state, setState] = useState('');
  const loaded = useApi<SubscriptionsPage>(`/api/inbox/subscriptions${query({ state })}`, refreshOnInbox);
  const action = useAction(loaded.reload);
  const path = (row: SubscriptionRow, verb: string) => `/api/inbox/subscriptions/${row.id}/${verb}`;
  return (
    <Page title="Subscriptions">
      <JobLine
        label="Last scan"
        last={loaded.data?.lastScan ?? null}
        button="Scan now"
        busy={action.busy}
        onRun={() => void action.runJob('subscriptions', 'The scan runs now. The table updates when it ends.')}
      />
      <ActionNotice notice={action.notice} />
      <div className="filters">
        <Select label="state" value={state} options={STATES} onChange={setState} />
      </div>
      <Load loaded={loaded}>
        {(page) => (
          <>
            <div className="tiles">
              {page.monthlyTotals.length ? (
                page.monthlyTotals.map((total) => (
                  <Tile
                    key={total.currency}
                    label={`Each month (${total.currency})`}
                    value={money(total.amount, null)}
                    note="an estimate from the cadence"
                  />
                ))
              ) : (
                <Tile label="Each month" value="-" note="no charge with a known cadence" />
              )}
            </div>
            <Panel title="Paid subscriptions">
              {page.subscriptions.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Merchant</th>
                      <th className="num">Amount</th>
                      <th>Cadence</th>
                      <th>Last charge</th>
                      <th>Next charge</th>
                      <th className="num">Sure</th>
                      <th>Source</th>
                      <th>State</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {page.subscriptions.map((row) => (
                      <tr key={row.id}>
                        <td className="wrap">
                          <strong>{row.merchant}</strong>
                          <div className="muted small">{row.account}</div>
                        </td>
                        <td className="num">{money(row.amount, row.currency)}</td>
                        <td>{row.cadence}</td>
                        <td>{time(row.lastChargeAt)}</td>
                        <td>{time(row.nextChargeAt)}</td>
                        <td className="num">{percent(row.confidence)}</td>
                        <td className="wrap">
                          {row.sourceSubject ?? <span className="muted">no subject</span>}
                          <div className="muted small">
                            {row.sourceMessageIds.length} {row.sourceMessageIds.length === 1 ? 'receipt' : 'receipts'}
                          </div>
                        </td>
                        <td className="wrap">
                          <InboxStatus value={row.state} />
                          {row.state === 'cancel_pending' && row.approvalId !== null ? (
                            <div>
                              <a href="#/approvals">approval #{row.approvalId}</a>
                            </div>
                          ) : null}
                          {row.browserTaskId ? (
                            <div>
                              <a href={`#/browser/${encodeURIComponent(row.browserTaskId)}`}>the browser task</a>
                            </div>
                          ) : null}
                          {/* the cancel link comes from mail, so it shows as text and is never an anchor. */}
                          {row.cancelUrl ? <code className="small">{row.cancelUrl}</code> : null}
                        </td>
                        <td>
                          <div className="row">
                            {row.state === 'active' ? (
                              <button type="button" disabled={action.busy} onClick={() => void action.act(path(row, 'cancel'), {})}>
                                Cancel
                              </button>
                            ) : null}
                            {row.state !== 'ignored' ? (
                              <button
                                type="button"
                                className="secondary"
                                disabled={action.busy}
                                onClick={() => void action.act(path(row, 'ignore'), {})}
                              >
                                Ignore
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No paid subscriptions found. A scan reads the receipts in the mail.</Empty>
              )}
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}
