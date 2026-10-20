import type { DigestStats } from '../../../../src/dashboard/inbox-types';
import type { DigestItem, DigestSection, DigestsPage, InboxDigest } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { longDay, time } from '../../format';
import type { RouteProps } from '../../routes';
import { Badge, ButtonLink, Count, DetailsPanel, EmptyState, isNotFound, NotFound, Page, Section, Skeleton } from '../../ui';
import { AccountBadge, LoadMore, money, refreshInbox, RunJob, usePaged, withQuery } from './shared';
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
        <AccountBadge account={item.account} />
        {/* a deadline, a bill or a package that a machine sent says so, so the owner knows that no person wrote it. */}
        {item.mail === 'automated' && item.section !== 'needs_reply' ? <Badge tone="muted">automated</Badge> : null}
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

// the accounts that the digest read, with the mail it hid, an account that had more mail than the read limit, and an
// account that it could not read. a digest of phase 5 has no stats and shows none of this.
function Coverage({ stats }: { stats: DigestStats }) {
  const hidden = stats.accounts.reduce((sum, account) => sum + account.hidden, 0);
  return (
    <div className="inbox-coverage">
      <ul className="inbox-coverage-list" aria-label="accounts in this digest">
        {stats.accounts.map((account) => (
          <li key={account.alias} className="inbox-coverage-item" data-testid={`coverage-${account.alias}`}>
            <AccountBadge account={account.alias} />
            {account.error !== null ? (
              <span className="error-text">Not read: {account.error}</span>
            ) : (
              <>
                <span>{account.capped ? `${account.read} of ${account.listed} read` : `${account.read} read`}</span>
                <span className="muted">{account.hidden} hidden</span>
                {account.capped ? (
                  <Badge tone="warning" title={`The digest read only the newest ${account.read} of ${account.listed} messages.`}>
                    more mail than the limit
                  </Badge>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="inbox-coverage-hidden">{hidden === 1 ? '1 automated or list mail hidden' : `${hidden} automated or list mails hidden`}</p>
    </div>
  );
}

function DigestBody({ digest }: { digest: InboxDigest }) {
  return (
    <>
      {digest.stats ? <Coverage stats={digest.stats} /> : null}
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
  const missing = loaded.error !== undefined && isNotFound(loaded.error);
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
          action={<RunJob job="digest" label="Make the digest now" note="Started. The digest shows here when it is ready." />}
        >
          The digest job reads the mail of each account once a day.
        </EmptyState>
      ) : missing ? (
        <NotFound icon="inbox" what="digest">
          <a href="#/inbox">Go to the latest digest</a>
        </NotFound>
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
