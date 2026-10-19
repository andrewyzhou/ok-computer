import { useState, type ReactNode } from 'react';
import type { ApprovalRow, InboxActionResponse, InboxJob, StreamMessage } from '../../../../src/dashboard/types';
import { api, send, useApi, type Loaded } from '../../api';
import { time } from '../../format';
import { ApprovalCard, Badge, Button, type Tone } from '../../ui';

// the parts that the five inbox views share: the reload rule, the hash query, the paging of a list, the money of a
// row, the run of a job and the approval that an action waits for.

// an inbox page loads again when a run ends or an approval changes, because a job or a decision changes its rows.
export const refreshInbox = (message: StreamMessage) => message.kind === 'approval' || message.kind === 'run';

// a filter lives in the query of the hash, so a link opens the list with its filter. the shell keeps the page when
// only the query changes, so the page keeps its state.
export function setHashQuery(path: string, query: URLSearchParams, changes: Record<string, string | null>): void {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  const search = next.toString();
  location.hash = `#/${path}${search ? `?${search}` : ''}`;
}

// a path with the query values that are set. an empty value is left out, so the server uses its default.
export function withQuery(path: string, values: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export interface Paged<P> extends Loaded<P> {
  // the first page and each page after it, in order.
  pages: P[];
  // null when the last page has no page after it.
  more: (() => void) | null;
  loadingMore: boolean;
  moreError?: string;
}

// a list with a load more button. the first page comes from useApi, so it loads again with the stream. the later
// pages belong to the first page that they follow, so a new first page drops them and the list starts again.
export function usePaged<P>(path: string | null, nextPath: (last: P) => string | null): Paged<P> {
  const first = useApi<P>(path, refreshInbox);
  const [later, setLater] = useState<{ of?: P; pages: P[]; busy: boolean; error?: string }>({ pages: [], busy: false });
  const current = later.of !== undefined && later.of === first.data ? later : { pages: [] as P[], busy: false, error: undefined };
  const pages = first.data === undefined ? [] : [first.data, ...current.pages];
  const last = pages.at(-1);
  const next = last === undefined ? null : nextPath(last);
  const more = () => {
    if (next === null || first.data === undefined) return;
    const of = first.data;
    setLater({ of, pages: current.pages, busy: true });
    api<P>(next).then(
      (page) => setLater((old) => (old.of === of ? { of, pages: [...old.pages, page], busy: false } : old)),
      (err: Error) => setLater((old) => (old.of === of ? { ...old, busy: false, error: err.message } : old)),
    );
  };
  return {
    ...first,
    pages,
    more: next === null ? null : more,
    loadingMore: current.busy,
    ...(current.error ? { moreError: current.error } : {}),
  };
}

export function LoadMore<P>({ paged, label = 'Load more' }: { paged: Paged<P>; label?: string }) {
  if (!paged.more && !paged.moreError) return null;
  return (
    <div className="inbox-more">
      {paged.more ? (
        <Button size="sm" busy={paged.loadingMore} onClick={paged.more}>
          {label}
        </Button>
      ) : null}
      {paged.moreError ? (
        <span role="alert" className="error-text">
          Could not load more: {paged.moreError}
        </span>
      ) : null}
    </div>
  );
}

// an amount in its currency, for example $12.99. a code that the browser does not know shows as the number and the
// code.
export function money(amount: number | null, currency: string | null): string {
  if (amount === null) return '-';
  if (!currency) return String(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// the day of a time in the owner's time zone, for example Oct 3. format.ts keeps the zone to itself, so this takes
// the day part of its time.
export function day(iso: string | null | undefined): string {
  return iso ? time(iso).split(',')[0]! : '-';
}

// a state word with its own tone. the shared Status mutes the words that it does not know, and the inbox states are
// new words.
export function StateBadge({ value, tones, labels }: { value: string; tones: Record<string, Tone>; labels?: Record<string, string> }) {
  return <Badge tone={tones[value] ?? 'muted'}>{labels?.[value] ?? value.replace(/_/g, ' ')}</Badge>;
}

export function RunLink({ runId, children }: { runId: string | null; children?: ReactNode }) {
  if (!runId) return <span className="muted">no run</span>;
  return <a href={`#/runs/${encodeURIComponent(runId)}`}>{children ?? `run ${runId.slice(0, 8)}`}</a>;
}

export function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inbox-external">
      {children ?? href}
    </a>
  );
}

// the last run of a job, for the subtitle of a page.
export function LastRun({ label, last }: { label: string; last: { runId: string | null; at: string } | null }) {
  if (!last) return <span>No {label} yet.</span>;
  return (
    <span>
      Last {label} {time(last.at)}
      {last.runId ? (
        <>
          {' · '}
          <RunLink runId={last.runId} />
        </>
      ) : null}
    </span>
  );
}

// a button that runs the automation of a job now. the answer is 202, and the page loads again when the run ends,
// because a run sends a stream message.
export function RunJob({ job, label, variant = 'secondary', note }: { job: InboxJob; label: string; variant?: 'primary' | 'secondary'; note?: string }) {
  const [state, setState] = useState<{ busy: boolean; done?: boolean; error?: string }>({ busy: false });
  const run = () => {
    setState({ busy: true });
    send<{ started: boolean }>('/api/inbox/run', 'POST', { job }).then(
      () => setState({ busy: false, done: true }),
      (err: Error) => setState({ busy: false, error: err.message }),
    );
  };
  return (
    <span className="inbox-run">
      <Button variant={variant} size={variant === 'primary' ? 'md' : 'sm'} icon="refresh" busy={state.busy} onClick={run}>
        {label}
      </Button>
      {state.done ? (
        <span role="status" className="muted">
          {note ?? 'Started.'}
        </span>
      ) : null}
      {state.error ? (
        <span role="alert" className="error-text">
          {state.error}
        </span>
      ) : null}
    </span>
  );
}

// the approvals of the dashboard, for the cards of the inbox actions. the list holds the pending ones first.
export function useApprovals(): Loaded<ApprovalRow[]> {
  return useApi<ApprovalRow[]>('/api/approvals', refreshInbox);
}

// the card of the approval that an action waits for, so the owner decides on the same page. an approval that is not
// in the list yet gets a link to the approvals page.
export function ApprovalFor({ id, approvals, onDecided }: { id: number; approvals: Loaded<ApprovalRow[]>; onDecided?: () => void }) {
  const approval = approvals.data?.find((each) => each.id === id);
  if (approval) return <ApprovalCard approval={approval} compact onDecided={() => onDecided?.()} />;
  if (approvals.error) return <span className="error-text">Could not load approval #{id}: {approvals.error}</span>;
  return (
    <span className="muted">
      Approval <a href="#/approvals">#{id}</a> waits on the approvals page.
    </span>
  );
}

// the answer of an action on one row. pending holds the approval that the action waits for.
export interface RowAnswer {
  error?: string;
  message?: string;
  approvalId?: number;
  busy?: boolean;
}

// the actions of the rows of a table: each row has its own busy state, answer and error, so the text shows next to
// the row that it is about. done loads the page again, and pending_approval keeps the approval for its card.
export function useRowActions(reload: () => void) {
  const [answers, setAnswers] = useState<Record<number, RowAnswer>>({});
  const act = (id: number, path: string, body: unknown = {}) => {
    setAnswers((old) => ({ ...old, [id]: { busy: true } }));
    return send<InboxActionResponse>(path, 'POST', body).then(
      (answer) => {
        setAnswers((old) => ({
          ...old,
          [id]: answer.status === 'pending_approval' && answer.approvalId !== null ? { message: answer.message, approvalId: answer.approvalId } : { message: answer.message },
        }));
        reload();
        return true;
      },
      (err: Error) => {
        setAnswers((old) => ({ ...old, [id]: { error: err.message } }));
        return false;
      },
    );
  };
  const clear = (id: number) =>
    setAnswers((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  return { answers, act, clear };
}

// the text under the actions of a row: the error of the last action, or its message.
export function RowNote({ answer }: { answer: RowAnswer | undefined }) {
  if (!answer || answer.busy) return null;
  if (answer.error)
    return (
      <span role="alert" className="error-text inbox-row-note">
        {answer.error}
      </span>
    );
  if (answer.message && answer.approvalId === undefined)
    return (
      <span role="status" className="muted inbox-row-note">
        {answer.message}
      </span>
    );
  return null;
}

// the approvals that the actions of this visit wait for, above the table, each with the name of its row.
export function PendingAnswers<T extends { id: number }>({
  answers,
  rows,
  name,
  approvals,
  onDecided,
  clear,
}: {
  answers: Record<number, RowAnswer>;
  rows: T[];
  name: (row: T) => string;
  approvals: Loaded<ApprovalRow[]>;
  onDecided: () => void;
  clear: (id: number) => void;
}) {
  const pending = Object.entries(answers).filter(([, answer]) => answer.approvalId !== undefined);
  if (!pending.length) return null;
  return (
    <div className="inbox-pending" aria-label="waiting for approval">
      {pending.map(([key, answer]) => {
        const row = rows.find((each) => each.id === Number(key));
        return (
          <div key={key} className="inbox-pending-item">
            <p className="inbox-pending-text">
              <strong>{row ? name(row) : `#${key}`}</strong> <span role="status">{answer.message}</span>{' '}
              <button type="button" className="link-button" onClick={() => clear(Number(key))}>
                Hide
              </button>
            </p>
            <ApprovalFor id={answer.approvalId!} approvals={approvals} onDecided={onDecided} />
          </div>
        );
      })}
    </div>
  );
}
