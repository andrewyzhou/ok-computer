import { useMemo } from 'react';
import type { DigestItem, DigestSection, DigestsPage, DigestSummary, InboxDigest } from '../../../../src/dashboard/types';
import { api, useApi } from '../../api';
import { Empty, Load, Page, Panel } from '../../components';
import { time } from '../../format';
import { ActionNotice, LoadMore, money, query, refreshOnInbox, RunLink, useAction, usePages, type Chunk } from './shared';

const SECTIONS: ReadonlyArray<{ id: DigestSection; label: string; empty: string }> = [
  { id: 'needs_reply', label: 'Needs a reply', empty: 'No mail waits for a reply.' },
  { id: 'deadlines', label: 'Deadlines', empty: 'No deadlines.' },
  { id: 'bills', label: 'Bills', empty: 'No bills.' },
  { id: 'packages', label: 'Packages', empty: 'No packages.' },
];

// the text of an item comes from mail, so each field renders as a text node. the links go to pages of ok computer,
// never to an address from the mail.
function Item({ item }: { item: DigestItem }) {
  return (
    <li className="card">
      <div className="wrap">
        <strong>{item.subject}</strong>
      </div>
      <div className="muted wrap">
        {item.from} · {item.account}
      </div>
      <p className="wrap">{item.summary}</p>
      <div className="row small">
        {item.dueAt ? <span>due {time(item.dueAt)}</span> : null}
        {item.amount !== null ? <span>{money(item.amount, item.currency)}</span> : null}
        {item.draftId !== null ? <a href="#/inbox/drafts">draft #{item.draftId}</a> : null}
        {item.proposalId !== null ? <a href="#/inbox/proposals">calendar proposal #{item.proposalId}</a> : null}
      </div>
    </li>
  );
}

function DigestView({ digest }: { digest: InboxDigest }) {
  return (
    <>
      <Panel title={`Digest of ${digest.day}`}>
        <p className="muted">
          {digest.accounts.length ? digest.accounts.join(', ') : 'no account'} · made {time(digest.createdAt)}{' '}
          <RunLink runId={digest.runId} />
        </p>
        <pre className="block">{digest.shortText}</pre>
      </Panel>
      {SECTIONS.map((section) => {
        const items = digest.items.filter((item) => item.section === section.id);
        return (
          <Panel key={section.id} title={`${section.label} (${items.length})`}>
            {items.length ? (
              <ul className="cards">
                {items.map((item) => (
                  <Item key={`${item.account}:${item.messageId}`} item={item} />
                ))}
              </ul>
            ) : (
              <Empty>{section.empty}</Empty>
            )}
          </Panel>
        );
      })}
    </>
  );
}

function OlderDigests() {
  const loaded = useApi<DigestsPage>('/api/inbox/digests', refreshOnInbox);
  const first = useMemo<Chunk<DigestSummary> | undefined>(
    () => (loaded.data ? { rows: loaded.data.digests, next: loaded.data.nextCursor } : undefined),
    [loaded.data],
  );
  const pages = usePages(first, (cursor) =>
    api<DigestsPage>(`/api/inbox/digests${query({ cursor })}`).then((page) => ({ rows: page.digests, next: page.nextCursor })),
  );
  return (
    <Panel title="All digests">
      <Load loaded={loaded}>
        {() =>
          pages.rows.length ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Items</th>
                    <th>Made</th>
                  </tr>
                </thead>
                <tbody>
                  {pages.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <a href={`#/inbox/digests/${row.id}`}>{row.day}</a>
                      </td>
                      <td className="num">{row.items}</td>
                      <td>{time(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <LoadMore pages={pages} />
            </>
          ) : (
            <Empty>No digests yet.</Empty>
          )
        }
      </Load>
    </Panel>
  );
}

// the latest digest at #/inbox, or one digest at #/inbox/digests/:id.
export function Digest({ params }: { params?: Record<string, string> }) {
  const id = params?.id;
  const loaded = useApi<InboxDigest>(id ? `/api/inbox/digests/${encodeURIComponent(id)}` : '/api/inbox/digests/latest', refreshOnInbox);
  const action = useAction(loaded.reload);
  const run = () => void action.runJob('digest', 'The digest runs now. This page shows it when the run ends.');
  // the server answers 404 digest not found before the first digest. the latest page then offers the first run.
  const none = !id && loaded.error === 'digest not found';
  return (
    <Page
      title={id ? 'Digest' : 'Inbox digest'}
      actions={
        <button type="button" disabled={action.busy} onClick={run}>
          Run the digest now
        </button>
      }
    >
      <ActionNotice notice={action.notice} />
      {none ? <Empty>no digest yet</Empty> : <Load loaded={loaded}>{(digest) => <DigestView digest={digest} />}</Load>}
      {id ? (
        <p>
          <a href="#/inbox">The latest digest</a>
        </p>
      ) : null}
      <OlderDigests />
    </Page>
  );
}
