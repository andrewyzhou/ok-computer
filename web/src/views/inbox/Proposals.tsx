import { useMemo, useState } from 'react';
import type { CalendarProposalView, ProposalState } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { Empty, Load, Page, Panel, Status } from '../../components';
import { time } from '../../format';
import { accountsOf, BEFORE_LIMIT, beforeChunk, fetchBefore, LoadMore, query, refreshOnInbox, RunLink, Select, usePages } from './shared';

const STATES: readonly ProposalState[] = ['proposed', 'approved', 'created', 'declined', 'expired', 'failed'];

// an all-day event has a day and no hour, so the page shows the date part of the iso string.
function when(proposal: CalendarProposalView): string {
  if (proposal.allDay) {
    const start = proposal.startAt.slice(0, 10);
    const end = proposal.endAt?.slice(0, 10);
    return `${start}${end && end !== start ? ` to ${end}` : ''}, all day`;
  }
  return proposal.endAt ? `${time(proposal.startAt)} to ${time(proposal.endAt)}` : time(proposal.startAt);
}

// the owner decides on a proposal on the approvals page, so this page has no decision button.
export function Proposals() {
  const [filter, setFilter] = useState({ account: '', state: '' });
  const path = (before?: string) => `/api/inbox/proposals${query({ ...filter, before, limit: BEFORE_LIMIT })}`;
  const loaded = useApi<CalendarProposalView[]>(path(), refreshOnInbox);
  const first = useMemo(() => (loaded.data ? beforeChunk(loaded.data) : undefined), [loaded.data]);
  const pages = usePages(first, fetchBefore<CalendarProposalView>(path));
  return (
    <Page title="Calendar proposals">
      <p className="muted">
        Events from course and bill deadlines in the mail. Each one waits for your approval on the <a href="#/approvals">approvals page</a>{' '}
        before ok computer adds it to the calendar.
      </p>
      <div className="filters">
        <Select
          label="account"
          value={filter.account}
          options={accountsOf(pages.rows, filter.account)}
          onChange={(account) => setFilter({ ...filter, account })}
        />
        <Select label="state" value={filter.state} options={STATES} onChange={(state) => setFilter({ ...filter, state })} />
      </div>
      <Panel title="Proposals">
        <Load loaded={loaded}>
          {() =>
            pages.rows.length ? (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Kind</th>
                      <th>When</th>
                      <th>State</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.rows.map((proposal) => (
                      <tr key={proposal.id}>
                        <td className="wrap">
                          <strong>{proposal.title}</strong>
                          <div className="muted small">
                            {proposal.account} · {proposal.calendarId}
                          </div>
                          {proposal.description ? <div className="muted small">{proposal.description}</div> : null}
                        </td>
                        <td>{proposal.kind}</td>
                        <td>{when(proposal)}</td>
                        <td className="wrap">
                          <Status value={proposal.state} />
                          {proposal.state === 'proposed' ? (
                            <div>
                              <a href="#/approvals">{proposal.approvalId !== null ? `approval #${proposal.approvalId}` : 'approvals'}</a>
                            </div>
                          ) : null}
                          {proposal.error ? <div className="error-text small">{proposal.error}</div> : null}
                          {proposal.resolvedAt ? <div className="muted small">{time(proposal.resolvedAt)}</div> : null}
                        </td>
                        <td className="wrap">
                          {proposal.sourceSubject ?? <span className="muted">no source mail</span>}
                          <div className="small">
                            <RunLink runId={proposal.runId} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <LoadMore pages={pages} />
              </>
            ) : (
              <Empty>No proposals match the filters.</Empty>
            )
          }
        </Load>
      </Panel>
    </Page>
  );
}
