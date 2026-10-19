import type { DraftState, DraftView } from '../../../../src/dashboard/types';
import { time } from '../../format';
import type { RouteProps } from '../../routes';
import { DetailsPanel, EmptyState, Facts, FilterBar, Page, Skeleton, Table, Tabs, type Column, type Tone } from '../../ui';
import { LoadMore, RunLink, StateBadge, setHashQuery, usePaged, withQuery } from './shared';
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

const COLUMNS: Array<Column<DraftView>> = [
  { key: 'to', header: 'To', wrap: true, cell: (draft) => draft.to.join(', ') || <span className="muted">no one</span> },
  { key: 'subject', header: 'Subject', wrap: true, cell: (draft) => draft.subject },
  { key: 'account', header: 'Account', hideBelow: 'md', cell: (draft) => draft.account },
  { key: 'created', header: 'Created', align: 'end', hideBelow: 'sm', cell: (draft) => time(draft.createdAt) },
];

function DraftFacts({ draft }: { draft: DraftView }) {
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'State', value: <StateBadge value={draft.state} tones={STATE_TONE} labels={STATE_LABEL} /> },
          { label: 'To', value: draft.to.join(', ') || <span className="muted">no one</span> },
          { label: 'Subject', value: draft.subject },
          { label: 'Account', value: draft.account },
          { label: 'Thread', value: <code>{draft.threadId}</code> },
          draft.inReplyTo ? { label: 'In reply to', value: <code>{draft.inReplyTo}</code> } : null,
          { label: 'Created', value: time(draft.createdAt) },
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
  const draft = selectedId ? drafts.find((each) => String(each.id) === selectedId) : undefined;
  const select = (id: string | null) => setHashQuery(PATH, query, { id });

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
        <p className="error-box">Could not load: {paged.error}</p>
      ) : paged.data === undefined ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <Table
            label="drafts"
            columns={COLUMNS}
            rows={drafts}
            rowKey={(each) => String(each.id)}
            selected={selectedId}
            onSelect={(each) => select(String(each.id) === selectedId ? null : String(each.id))}
            empty={
              <EmptyState icon="draft" title={tab === 'drafted' ? 'No drafts yet.' : `No drafts are ${STATE_LABEL[tab]}.`}>
                {tab === 'drafted' ? 'The digest writes a draft reply for mail that needs one.' : null}
              </EmptyState>
            }
          />
          <LoadMore paged={paged} label="Load older" />
        </>
      )}
      {draft ? (
        <DetailsPanel title={draft.subject} openKey={draft.id} onClose={() => select(null)}>
          <DraftFacts draft={draft} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Drafts" {...(selectedId ? { onClose: () => select(null) } : {})}>
          {selectedId && paged.data !== undefined ? (
            <p className="muted">Draft #{selectedId} is not in this list. It may be in another tab, or older than the rows that are loaded.</p>
          ) : (
            <p className="muted">Select a draft to read its text.</p>
          )}
          <p className="inbox-note">ok computer never sends a draft. Open your mail drafts to send it.</p>
        </DetailsPanel>
      )}
    </Page>
  );
}
