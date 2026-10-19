import type { MouseEvent } from 'react';
import type { CalendarProposalView, ProposalState } from '../../../../src/dashboard/types';
import { clock, longDay, time } from '../../format';
import type { RouteProps } from '../../routes';
import { Badge, DetailsPanel, EmptyState, Facts, FilterBar, Page, Skeleton, Tabs, type Tone } from '../../ui';
import { ApprovalFor, LoadMore, RunLink, StateBadge, setHashQuery, useApprovals, usePaged, withQuery } from './shared';
import './inbox.css';

// the calendar events that the digest job proposes, for example a course deadline or a bill. the owner approves each
// one through its approval, and only then does the app create the event.

const PATH = 'inbox/proposals';
const LIMIT = 50;

const TABS: Array<{ id: ProposalState; label: string }> = [
  { id: 'proposed', label: 'Proposed' },
  { id: 'approved', label: 'Approved' },
  { id: 'created', label: 'Created' },
  { id: 'declined', label: 'Declined' },
  { id: 'expired', label: 'Expired' },
  { id: 'failed', label: 'Failed' },
];

const STATE_TONE: Record<ProposalState, Tone> = {
  proposed: 'warning',
  approved: 'info',
  created: 'good',
  declined: 'serious',
  expired: 'muted',
  failed: 'critical',
};

const KIND_TONE: Record<CalendarProposalView['kind'], Tone> = { course: 'info', bill: 'warning', other: 'muted' };

// an all-day event shows its day. another event shows its start and the clock of its end.
export function when(proposal: CalendarProposalView): string {
  if (proposal.allDay) return longDay(proposal.startAt.slice(0, 10));
  return proposal.endAt ? `${time(proposal.startAt)} to ${clock(proposal.endAt)}` : time(proposal.startAt);
}

function fromControl(event: MouseEvent): boolean {
  return Boolean((event.target as HTMLElement).closest('a, button, input, select, textarea'));
}

function ProposalItem({
  proposal,
  selected,
  approvals,
  onSelect,
  onDecided,
}: {
  proposal: CalendarProposalView;
  selected: boolean;
  approvals: ReturnType<typeof useApprovals>;
  onSelect: () => void;
  onDecided: () => void;
}) {
  return (
    // a click anywhere on the item selects it. the title is the button for the keyboard and a screen reader.
    <li className={selected ? 'inbox-proposal is-selected' : 'inbox-proposal'} data-testid={`proposal-${proposal.id}`} onClick={(event) => !fromControl(event) && onSelect()}>
      <div className="inbox-item-head">
        <button type="button" className="inbox-proposal-title" aria-pressed={selected} onClick={onSelect}>
          {proposal.title}
        </button>
        <Badge tone={KIND_TONE[proposal.kind]}>{proposal.kind}</Badge>
        <StateBadge value={proposal.state} tones={STATE_TONE} />
      </div>
      <p className="inbox-proposal-when">{when(proposal)}</p>
      {proposal.sourceSubject ? <p className="muted small">from the mail “{proposal.sourceSubject}”</p> : null}
      {proposal.error ? <p className="error-text small">{proposal.error}</p> : null}
      {proposal.state === 'created' && proposal.eventId ? <p className="muted small">event {proposal.eventId}</p> : null}
      {proposal.state === 'proposed' && proposal.approvalId !== null ? (
        <div className="inbox-proposal-approval">
          <ApprovalFor id={proposal.approvalId} approvals={approvals} onDecided={onDecided} />
        </div>
      ) : null}
    </li>
  );
}

function ProposalFacts({ proposal }: { proposal: CalendarProposalView }) {
  return (
    <Facts
      layout="stacked"
      items={[
        { label: 'State', value: <StateBadge value={proposal.state} tones={STATE_TONE} /> },
        { label: 'When', value: when(proposal) },
        { label: 'Kind', value: proposal.kind },
        { label: 'Account', value: proposal.account },
        { label: 'Calendar', value: proposal.calendarId },
        proposal.description ? { label: 'Description', value: <div className="inbox-body">{proposal.description}</div> } : null,
        { label: 'Source', value: proposal.sourceSubject ?? <span className="muted">none</span> },
        proposal.sourceMessageId ? { label: 'Source message', value: <code>{proposal.sourceMessageId}</code> } : null,
        proposal.approvalId !== null ? { label: 'Approval', value: <a href="#/approvals">#{proposal.approvalId}</a> } : null,
        proposal.eventId ? { label: 'Event', value: <code>{proposal.eventId}</code> } : null,
        proposal.error ? { label: 'Error', value: <span className="error-text">{proposal.error}</span> } : null,
        { label: 'Created', value: time(proposal.createdAt) },
        { label: 'Resolved', value: time(proposal.resolvedAt) },
        { label: 'Run', value: <RunLink runId={proposal.runId} /> },
      ]}
    />
  );
}

export function ProposalsPage({ query }: RouteProps) {
  const tab = TABS.find((each) => each.id === query.get('state'))?.id ?? 'proposed';
  const selectedId = query.get('id');
  const filters = { state: tab, limit: LIMIT };
  const paged = usePaged<CalendarProposalView[]>(withQuery('/api/inbox/proposals', filters), (last) =>
    last.length < LIMIT ? null : withQuery('/api/inbox/proposals', { ...filters, before: last.at(-1)!.id }),
  );
  const approvals = useApprovals();
  const reload = () => {
    paged.reload();
    approvals.reload();
  };
  const proposals = paged.pages.flat();
  const proposal = selectedId ? proposals.find((each) => String(each.id) === selectedId) : undefined;
  const select = (id: string | null) => setHashQuery(PATH, query, { id });

  return (
    <Page
      title="Proposals"
      subtitle="Calendar events from the mail. Each one waits for your approval before it reaches the calendar."
      toolbar={
        <FilterBar label="proposal filters">
          <Tabs label="proposal state" items={TABS} value={tab} onChange={(state) => setHashQuery(PATH, query, { state: state === 'proposed' ? null : state, id: null })} />
        </FilterBar>
      }
    >
      {paged.error ? (
        <p className="error-box">Could not load: {paged.error}</p>
      ) : paged.data === undefined ? (
        <Skeleton lines={5} />
      ) : proposals.length ? (
        <>
          <ul className="inbox-proposals" aria-label="calendar proposals">
            {proposals.map((each) => (
              <ProposalItem
                key={each.id}
                proposal={each}
                selected={String(each.id) === selectedId}
                approvals={approvals}
                onSelect={() => select(String(each.id) === selectedId ? null : String(each.id))}
                onDecided={reload}
              />
            ))}
          </ul>
          <LoadMore paged={paged} label="Load older" />
        </>
      ) : (
        <EmptyState icon="calendar" title={tab === 'proposed' ? 'No proposals wait for you.' : `No ${tab} proposals.`}>
          {tab === 'proposed' ? 'The digest proposes an event when the mail has a deadline or a bill.' : null}
        </EmptyState>
      )}
      {proposal ? (
        <DetailsPanel title={proposal.title} openKey={proposal.id} onClose={() => select(null)}>
          <ProposalFacts proposal={proposal} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Proposals" {...(selectedId ? { onClose: () => select(null) } : {})}>
          {selectedId && paged.data !== undefined ? (
            <p className="muted">Proposal #{selectedId} is not in this list. It may be in another tab, or older than the rows that are loaded.</p>
          ) : (
            <p className="muted">Select a proposal to see its calendar, its source and its approval.</p>
          )}
        </DetailsPanel>
      )}
    </Page>
  );
}
