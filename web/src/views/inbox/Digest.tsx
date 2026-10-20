import type { DigestStats } from '../../../../src/dashboard/inbox-types';
import type { DigestItem, DigestSection, DigestsPage, InboxDigest } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { longDay } from '../../format';
import type { RouteProps } from '../../routes';
import { Badge, ButtonLink, Count, DetailsPanel, EmptyState, isNotFound, NotFound, Page, Section, Skeleton } from '../../ui';
import { AccountBadge, ConnectGoogle, ErrorBox, LoadMore, minuteTime, money, refreshInbox, RunJob, useInboxSetup, usePaged, withQuery } from './shared';
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
        <AccountBadge account={item.account} full />
        {/* a deadline, a bill or a package that a machine sent says so, so the owner knows that no person wrote it. it is
            plain small text, so it never reads as the badge of another account. */}
        {item.mail === 'automated' && item.section !== 'needs_reply' ? <span className="inbox-item-kind">automated mail</span> : null}
        {item.mail === 'list' && item.section === 'needs_reply' ? <span className="inbox-item-kind">to a list</span> : null}
      </div>
      <p className="inbox-item-subject">{item.subject}</p>
      <p className="inbox-item-summary">{item.summary}</p>
      <div className="inbox-item-meta">
        {item.dueAt ? <span>due {minuteTime(item.dueAt)}</span> : null}
        {item.amount !== null ? <span className="inbox-amount">{money(item.amount, item.currency)}</span> : null}
        {item.draftId !== null ? <a href={`#/inbox/drafts?id=${item.draftId}`}>draft</a> : null}
        {item.proposalId !== null ? <a href={`#/inbox/proposals?id=${item.proposalId}`}>calendar proposal</a> : null}
      </div>
    </li>
  );
}

// the longest alias that fits the column of the badges at a phone width.
const LONG_ALIAS = 10;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// the accounts that the digest read, with the mail it hid, an account that had more mail than the read limit, and an
// account that it could not read. a digest of phase 5 has no stats and shows none of this.
function Coverage({ stats }: { stats: DigestStats }) {
  const hidden = stats.accounts.reduce((sum, account) => sum + account.hidden, 0);
  const left = [
    plural(hidden, 'automated or list mail hidden', 'automated or list mails hidden'),
    stats.pastDue ? plural(stats.pastDue, 'past deadline left out', 'past deadlines left out') : null,
    stats.notDeadlines ? plural(stats.notDeadlines, 'mail that sets no deadline left out', 'mails that set no deadline left out') : null,
    // a due date that the mail does not state is dropped, and a deadline without its date is left out, so the owner
    // learns that the mail may hold more deadlines than the list shows.
    stats.droppedDates ? plural(stats.droppedDates, 'due date left out because the mail did not state it', 'due dates left out because the mail did not state them') : null,
  ].filter(Boolean);
  return (
    <div className="inbox-coverage">
      <ul className="inbox-coverage-list" aria-label="accounts in this digest">
        {stats.accounts.map((account) => (
          // a long alias, such as an address, takes the whole row, and its facts go under it, so the owner can read all of it.
          <li
            key={account.alias}
            className={account.alias.length > LONG_ALIAS ? 'inbox-coverage-item is-long' : 'inbox-coverage-item'}
            data-testid={`coverage-${account.alias}`}
          >
            <AccountBadge account={account.alias} full />
            {/* the facts of an account wrap in their own column, so a warning or an error stays next to its account. */}
            <span className="inbox-coverage-facts">
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
            </span>
          </li>
        ))}
      </ul>
      <p className="inbox-coverage-hidden">{left.join(' · ')}</p>
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

// the past digests, newest first, in the details panel. the one on the page is marked. when the main area failed
// for the same reason, the panel says it in one short line and does not repeat the error.
function PastDigests({ currentId, quiet }: { currentId: number | undefined; quiet: boolean }) {
  const paged = usePaged<DigestsPage>('/api/inbox/digests', (last) => (last.nextCursor ? withQuery('/api/inbox/digests', { cursor: last.nextCursor }) : null));
  const digests = paged.pages.flatMap((page) => page.digests);
  return (
    <DetailsPanel title="Past digests">
      {paged.error ? (
        <p className="error-text">{quiet ? 'Could not load the past digests.' : `Could not load: ${paged.error}`}</p>
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
  const setup = useInboxSetup();
  const digest = loaded.data;
  const missing = loaded.error !== undefined && isNotFound(loaded.error);
  const crumbs = id ? [{ label: 'Digest', href: '#/inbox' }] : undefined;
  // the accounts are in the coverage list below, so the subtitle gives only their number. a list of long addresses
  // ran off the edge of a phone.
  const count = digest?.accounts.length ?? 0;
  return (
    <Page
      title="Digest"
      {...(crumbs ? { crumbs } : {})}
      subtitle={digest ? `${longDay(digest.day)} · ${count === 0 ? 'no accounts' : plural(count, 'account', 'accounts')}` : undefined}
      actions={
        digest?.runId ? (
          <ButtonLink href={`#/runs/${encodeURIComponent(digest.runId)}`} size="sm" variant="ghost" icon="run">
            Open the run
          </ButtonLink>
        ) : undefined
      }
    >
      {missing && !id && setup.state === 'missing' ? (
        <ConnectGoogle what="The digest reads the mail of each account once a day." />
      ) : missing && !id ? (
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
        <ErrorBox error={loaded.error} onRetry={loaded.reload} />
      ) : digest ? (
        <DigestBody digest={digest} />
      ) : (
        <Skeleton lines={5} />
      )}
      <PastDigests currentId={digest?.id} quiet={loaded.error !== undefined && !missing} />
    </Page>
  );
}
