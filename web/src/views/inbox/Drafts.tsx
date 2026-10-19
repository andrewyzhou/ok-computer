import { useMemo, useState } from 'react';
import type { DraftState, DraftView } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { Empty, Load, Page, Panel } from '../../components';
import { time } from '../../format';
import { accountsOf, BEFORE_LIMIT, beforeChunk, fetchBefore, InboxStatus, LoadMore, query, refreshOnInbox, RunLink, Select, usePages } from './shared';

const STATES: readonly DraftState[] = ['drafted', 'discarded', 'sent_by_owner'];

export function Drafts() {
  const [filter, setFilter] = useState({ account: '', state: '' });
  const path = (before?: string) => `/api/inbox/drafts${query({ ...filter, before, limit: BEFORE_LIMIT })}`;
  const loaded = useApi<DraftView[]>(path(), refreshOnInbox);
  const first = useMemo(() => (loaded.data ? beforeChunk(loaded.data) : undefined), [loaded.data]);
  const pages = usePages(first, fetchBefore<DraftView>(path));
  return (
    <Page title="Drafts">
      <p className="muted">
        These replies wait in the drafts folder of the account. ok computer never sends a draft: you read it, change it and send it
        yourself.
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
      <Load loaded={loaded}>
        {() =>
          pages.rows.length ? (
            <>
              <ul className="cards">
                {pages.rows.map((draft) => (
                  <li key={draft.id} className="card">
                    <div className="row">
                      <strong className="wrap">{draft.subject}</strong>
                      <InboxStatus value={draft.state} />
                    </div>
                    <div className="muted small wrap">
                      to {draft.to.length ? draft.to.join(', ') : 'nobody'} · {draft.account} · {time(draft.createdAt)}{' '}
                      <RunLink runId={draft.runId} />
                    </div>
                    <pre className="block">{draft.body}</pre>
                  </li>
                ))}
              </ul>
              <LoadMore pages={pages} />
            </>
          ) : (
            <Panel title="No drafts">
              <Empty>No draft replies match the filters. The digest writes them for mail that needs a reply.</Empty>
            </Panel>
          )
        }
      </Load>
    </Page>
  );
}
