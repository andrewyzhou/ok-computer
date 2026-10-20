import { useEffect } from 'react';
import type { DraftState, DraftView } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import type { RouteProps } from '../../routes';
import { DetailsPanel, EmptyState, Facts, FilterBar, Page, Skeleton, Table, Tabs, type Column, type Tone } from '../../ui';
import {
  accountColumn,
  AccountBelowMd,
  Breakable,
  ConnectGoogle,
  ErrorBox,
  LoadMore,
  minuteTime,
  RunLink,
  StateBadge,
  setHashQuery,
  useInboxSetup,
  usePaged,
  withQuery,
} from './shared';
import './inbox.css';

// the draft replies that the digest job wrote into the mail drafts of an account. the app never sends a draft: the
// owner reads it here, then opens the drafts of the account to change it and send it.

const PATH = 'inbox/drafts';
const LIMIT = 50;

const TABS: Array<{ id: DraftState; label: string }> = [
  { id: 'drafted', label: 'Drafted' },
  { id: 'discarded', label: 'Discarded' },
  { id: 'sent_by_owner', label: 'Sent by you' },
];

const STATE_TONE: Record<DraftState, Tone> = { drafted: 'info', discarded: 'muted', sent_by_owner: 'good' };
const STATE_LABEL: Record<DraftState, string> = { drafted: 'drafted', discarded: 'discarded', sent_by_owner: 'sent by you' };

// the first recipient on one line, and the count of the others. the whole list is in the title and in the details.
function Recipients({ to }: { to: string[] }) {
  if (!to.length) return <span className="muted">no one</span>;
  return (
    <span className="inbox-to" title={to.join(', ')}>
      <span className="inbox-to-first">{to[0]}</span>
      {to.length > 1 ? <span className="muted"> +{to.length - 1}</span> : null}
    </span>
  );
}

const COLUMNS: Array<Column<DraftView>> = [
  { key: 'to', header: 'To', cell: (draft) => <Recipients to={draft.to} /> },
  // below md the account column is hidden, so the account shows under the subject.
  {
    key: 'subject',
    header: 'Subject',
    wrap: true,
    cell: (draft) => (
      <div className="inbox-name">
        <span>{draft.subject}</span>
        <AccountBelowMd account={draft.account} />
      </div>
    ),
  },
  accountColumn<DraftView>(),
  { key: 'created', header: 'Created', align: 'end', hideBelow: 'sm', cell: (draft) => minuteTime(draft.createdAt) },
];

function DraftFacts({ draft }: { draft: DraftView }) {
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'State', value: <StateBadge value={draft.state} tones={STATE_TONE} labels={STATE_LABEL} /> },
          { label: 'To', value: draft.to.length ? <Breakable text={draft.to.join(', ')} /> : <span className="muted">no one</span> },
          { label: 'Subject', value: draft.subject },
          { label: 'Account', value: <Breakable text={draft.account} /> },
          { label: 'Thread', value: <code>{draft.threadId}</code> },
          draft.inReplyTo ? { label: 'In reply to', value: <code>{draft.inReplyTo}</code> } : null,
          { label: 'Created', value: minuteTime(draft.createdAt) },
          { label: 'Run', value: <RunLink runId={draft.runId} /> },
        ]}
      />
      <h3 className="inbox-subhead">Body</h3>
      <div className="inbox-body">{draft.body}</div>
      <p className="inbox-note">ok computer never sends a draft. Open your mail drafts to send it.</p>
    </>
  );
}

export function DraftsPage({ query }: RouteProps) {
  const tab = TABS.find((each) => each.id === query.get('state'))?.id ?? 'drafted';
  const account = query.get('account') ?? '';
  const selectedId = query.get('id');
  const filters = { state: tab, account, limit: LIMIT };
  const paged = usePaged<DraftView[]>(withQuery('/api/inbox/drafts', filters), (last) =>
    last.length < LIMIT ? null : withQuery('/api/inbox/drafts', { ...filters, before: last.at(-1)!.id }),
  );
  const drafts = paged.pages.flat();
  const setup = useInboxSetup();
  const listed = selectedId ? drafts.find((each) => String(each.id) === selectedId) : undefined;
  // a link from the digest names a draft that may be in another tab or older than the loaded rows, so the page asks
  // for that one draft by its id when the list does not have it.
  const lookup = selectedId && /^[1-9]\d{0,15}$/.test(selectedId) && paged.data !== undefined && !listed ? `/api/inbox/drafts/${selectedId}` : null;
  const single = useApi<DraftView>(lookup);
  const draft = listed ?? single.data;
  const select = (id: string | null) => setHashQuery(PATH, query, { id });
  // a link from the digest or the brief names only the id. a draft that the owner sent or discarded is in another
  // tab, so the page opens the tab of the draft, and the list then shows the selected row.
  const otherTab = !query.get('state') && single.data !== undefined && single.data.state !== tab ? single.data.state : null;
  useEffect(() => {
    if (otherTab) setHashQuery(PATH, query, { state: otherTab });
  }, [otherTab, query]);

  return (
    <Page
      title="Drafts"
      subtitle="Replies that the digest wrote for you. They wait in the drafts of the account, and only you can send them."
      toolbar={
        <FilterBar label="draft filters">
          <Tabs label="draft state" items={TABS} value={tab} onChange={(state) => setHashQuery(PATH, query, { state: state === 'drafted' ? null : state, id: null })} />
        </FilterBar>
      }
    >
      {paged.error ? (
        <ErrorBox error={paged.error} onRetry={paged.reload} />
      ) : paged.data === undefined ? (
        <Skeleton lines={5} />
      ) : (
        <>
          {/* the creation time is in the details panel too, so a narrow table drops it. */}
          <div className="inbox-table inbox-table-drop-last">
            <Table
              label="drafts"
              columns={COLUMNS}
              rows={drafts}
              rowKey={(each) => String(each.id)}
              selected={selectedId}
              onSelect={(each) => select(String(each.id) === selectedId ? null : String(each.id))}
              empty={
                tab === 'drafted' && !account && setup.state === 'missing' ? (
                  <ConnectGoogle what="The digest writes a draft reply for mail that needs one." />
                ) : (
                  <EmptyState icon="draft" title={tab === 'drafted' ? 'No drafts yet.' : `No drafts are ${STATE_LABEL[tab]}.`}>
                    {tab === 'drafted' ? 'The digest writes a draft reply for mail that needs one.' : null}
                  </EmptyState>
                )
              }
            />
          </div>
          <LoadMore paged={paged} label="Load older" />
        </>
      )}
      {draft ? (
        <DetailsPanel title={draft.subject} openKey={draft.id} onClose={() => select(null)}>
          <DraftFacts draft={draft} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Drafts" {...(selectedId ? { onClose: () => select(null) } : {})}>
          {selectedId && paged.data !== undefined && (lookup === null || /not found/i.test(single.error ?? '')) ? (
            <p className="muted">Draft #{selectedId} was not found.</p>
          ) : selectedId && single.error !== undefined ? (
            <p className="error-text">Could not load draft #{selectedId}: {single.error}</p>
          ) : selectedId && paged.data !== undefined ? (
            <Skeleton lines={3} />
          ) : (
            <p className="muted">Select a draft to read its text.</p>
          )}
          <p className="inbox-note">ok computer never sends a draft. Open your mail drafts to send it.</p>
        </DetailsPanel>
      )}
    </Page>
  );
}
