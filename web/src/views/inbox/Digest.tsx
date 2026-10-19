import type { DigestItem, DigestSection, DigestsPage, InboxDigest } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { longDay, time } from '../../format';
import type { RouteProps } from '../../routes';
import { Badge, ButtonLink, Count, DetailsPanel, EmptyState, Page, Section, Skeleton } from '../../ui';
import { LoadMore, money, refreshInbox, RunJob, usePaged, withQuery } from './shared';
import './inbox.css';

// the daily digest of the inbox: the mail that needs a reply, the deadlines, the bills and the packages, with links
// to the draft replies and the calendar proposals that the job made. the same page shows a past digest by its id.

const SECTIONS: Array<{ id: DigestSection; label: string; empty: string }> = [
  { id: 'needs_reply', label: 'Needs a reply', empty: 'No mail waits for a reply.' },
  { id: 'deadlines', label: 'Deadlines', empty: 'No deadlines in the mail.' },
  { id: 'bills', label: 'Bills', empty: 'No bills in the mail.' },
  { id: 'packages', label: 'Packages', empty: 'No packages on the way.' },
];

function Item({ item }: { item: DigestItem }) {
  return (
    <li className="inbox-item">
      <div className="inbox-item-head">
        <strong className="inbox-item-from">{item.from}</strong>
        <Badge tone="muted">{item.account}</Badge>
      </div>
      <p className="inbox-item-subject">{item.subject}</p>
      <p className="inbox-item-summary">{item.summary}</p>
      <div className="inbox-item-meta">
        {item.dueAt ? <span>due {time(item.dueAt)}</span> : null}
        {item.amount !== null ? <span className="inbox-amount">{money(item.amount, item.currency)}</span> : null}
        {item.draftId !== null ? <a href={`#/inbox/drafts?id=${item.draftId}`}>draft</a> : null}
        {item.proposalId !== null ? <a href={`#/inbox/proposals?id=${item.proposalId}`}>calendar proposal</a> : null}
      </div>
    </li>
  );
}

function DigestBody({ digest }: { digest: InboxDigest }) {
  return (
    <>
      {SECTIONS.map((section) => {
        const items = digest.items.filter((item) => item.section === section.id);
        return (
          <Section
            key={section.id}
            id={`digest-${section.id}`}
            title={
              <>
                {section.label} <Count value={items.length} label="items" />
              </>
            }
          >
            {items.length ? (
              <ul className="inbox-items" aria-label={section.label}>
                {items.map((item) => (
                  <Item key={`${item.account}:${item.messageId}`} item={item} />
                ))}
              </ul>
            ) : (
              <p className="muted">{section.empty}</p>
            )}
          </Section>
        );
      })}
      <Section title="Message sent to the phone" description="The short text that the job sent with the digest.">
        <pre className="inbox-short">{digest.shortText}</pre>
      </Section>
    </>
  );
}

// the past digests, newest first, in the details panel. the one on the page is marked.
function PastDigests({ currentId }: { currentId: number | undefined }) {
  const paged = usePaged<DigestsPage>('/api/inbox/digests', (last) => (last.nextCursor ? withQuery('/api/inbox/digests', { cursor: last.nextCursor }) : null));
  const digests = paged.pages.flatMap((page) => page.digests);
  return (
    <DetailsPanel title="Past digests">
      {paged.error ? (
        <p className="error-text">Could not load: {paged.error}</p>
      ) : paged.data === undefined ? (
        <Skeleton lines={3} />
      ) : digests.length ? (
        <ul className="inbox-past">
          {digests.map((digest) => (
            <li key={digest.id}>
              <a href={`#/inbox/digests/${digest.id}`} aria-current={digest.id === currentId ? 'page' : undefined}>
                {longDay(digest.day)}
              </a>
              <span className="muted">{digest.items === 1 ? '1 item' : `${digest.items} items`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No past digests yet.</p>
      )}
      <LoadMore paged={paged} />
    </DetailsPanel>
  );
}

export function DigestPage({ params }: RouteProps) {
  const id = params.id;
  const loaded = useApi<InboxDigest>(id ? `/api/inbox/digests/${encodeURIComponent(id)}` : '/api/inbox/digests/latest', refreshInbox);
  const digest = loaded.data;
  const missing = loaded.error !== undefined && /not found/i.test(loaded.error);
  const crumbs = id ? [{ label: 'Digest', href: '#/inbox' }] : undefined;
  return (
    <Page
      title="Digest"
      {...(crumbs ? { crumbs } : {})}
      subtitle={digest ? `${longDay(digest.day)} · ${digest.accounts.join(', ') || 'no accounts'}` : undefined}
      actions={
        digest?.runId ? (
          <ButtonLink href={`#/runs/${encodeURIComponent(digest.runId)}`} size="sm" variant="ghost" icon="run">
            Open the run
          </ButtonLink>
        ) : undefined
      }
    >
      {missing && !id ? (
        <EmptyState
          icon="inbox"
          title="No digest yet."
          action={<RunJob job="digest" label="Make the digest now" variant="primary" note="Started. The digest shows here when it is ready." />}
        >
          The digest job reads the mail of each account once a day.
        </EmptyState>
      ) : missing ? (
        <EmptyState icon="inbox" title="This digest does not exist.">
          <a href="#/inbox">Go to the latest digest</a>
        </EmptyState>
      ) : loaded.error ? (
        <p className="error-box">Could not load: {loaded.error}</p>
      ) : digest ? (
        <DigestBody digest={digest} />
      ) : (
        <Skeleton lines={5} />
      )}
      <PastDigests currentId={digest?.id} />
    </Page>
  );
}
