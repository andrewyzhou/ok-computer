import { useState, type ReactNode } from 'react';
import type { InboxActionResponse, InboxJob, StreamMessage } from '../../../../src/dashboard/types';
import { api, send } from '../../api';
import { time } from '../../format';

// the inbox lists change when a job run ends and when the owner decides on one of their approvals.
export const refreshOnInbox = (message: StreamMessage) => message.kind === 'run' || message.kind === 'approval';

// an amount from a receipt or a bill. the currency comes from mail, so the page shows it as plain text and never gives
// it to a formatter that could throw on an unknown code.
export function money(amount: number | null, currency: string | null): string {
  if (amount === null) return '-';
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

export function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export type Notice = { kind: 'result'; result: InboxActionResponse } | { kind: 'text'; text: string } | { kind: 'error'; text: string };

// the answer of the last action on the page. an action that waits for the owner links to the approvals page.
export function ActionNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  if (notice.kind === 'error') return <p className="error-box">{notice.text}</p>;
  if (notice.kind === 'text') return <p className="muted">{notice.text}</p>;
  return (
    <p className="wrap">
      {notice.result.message}
      {notice.result.status === 'pending_approval' ? (
        <>
          {' '}
          <a href="#/approvals">Open the approval{notice.result.approvalId !== null ? ` #${notice.result.approvalId}` : ''}</a>
        </>
      ) : null}
    </p>
  );
}

// one action at a time. the buttons are disabled while it runs, and onDone reloads the list.
export function useAction(onDone: () => void) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (path: string, body: unknown) => {
    setBusy(true);
    return send<InboxActionResponse>(path, 'POST', body).then(
      (result) => {
        setBusy(false);
        setNotice({ kind: 'result', result });
        onDone();
      },
      (err: Error) => {
        setBusy(false);
        setNotice({ kind: 'error', text: err.message });
      },
    );
  };
  const runJob = (job: InboxJob, text: string) => {
    setBusy(true);
    return send<{ started: true }>('/api/inbox/run', 'POST', { job }).then(
      () => {
        setBusy(false);
        setNotice({ kind: 'text', text });
      },
      (err: Error) => {
        setBusy(false);
        setNotice({ kind: 'error', text: err.message });
      },
    );
  };
  return { notice, busy, act, runJob };
}

export interface Chunk<R> {
  rows: R[];
  next: string | null;
}

// the older pages of a list that the page loads with load more. the first page comes from useApi. when it changes,
// for example after a reload from the stream, the older pages are dropped, so the list never mixes old and new rows.
export function usePages<R>(first: Chunk<R> | undefined, fetchNext: (next: string) => Promise<Chunk<R>>) {
  const [more, setMore] = useState<{ base?: Chunk<R>; rows: R[]; next: string | null; busy: boolean; error?: string }>({
    rows: [],
    next: null,
    busy: false,
  });
  const fresh = first !== undefined && more.base === first;
  const rows = first ? (fresh ? [...first.rows, ...more.rows] : first.rows) : [];
  const next = fresh ? more.next : (first?.next ?? null);
  const loadMore = () => {
    if (!first || !next) return;
    const base = first;
    const kept = fresh ? more.rows : [];
    setMore({ base, rows: kept, next, busy: true });
    fetchNext(next).then(
      (page) => setMore({ base, rows: [...kept, ...page.rows], next: page.next, busy: false }),
      (err: Error) => setMore({ base, rows: kept, next, busy: false, error: err.message }),
    );
  };
  return { rows, next, loadMore, busy: fresh && more.busy, error: fresh ? more.error : undefined };
}

export function LoadMore({ pages }: { pages: { next: string | null; loadMore: () => void; busy: boolean; error?: string | undefined } }) {
  if (!pages.next && !pages.error) return null;
  return (
    <div className="row">
      {pages.next ? (
        <button type="button" className="secondary" disabled={pages.busy} onClick={pages.loadMore}>
          {pages.busy ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
      {pages.error ? <span className="error-text">{pages.error}</span> : null}
    </div>
  );
}

// the before paging of the drafts and the proposals: a full page may have older rows, and the last id is the cursor.
export const BEFORE_LIMIT = 50;

export function beforeChunk<R extends { id: number }>(rows: R[]): Chunk<R> {
  const last = rows[rows.length - 1];
  return { rows, next: rows.length >= BEFORE_LIMIT && last ? String(last.id) : null };
}

export function fetchBefore<R extends { id: number }>(path: (before: string) => string): (next: string) => Promise<Chunk<R>> {
  return (before) => api<R[]>(path(before)).then(beforeChunk);
}

// the list has no list of accounts, so the filter offers the accounts of the rows it has.
export function accountsOf(rows: Array<{ account: string }>, current: string): string[] {
  return [...new Set([...rows.map((row) => row.account), ...(current ? [current] : [])])].sort();
}

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">all</option>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

// the last run of a job, with a button that starts it now.
export function JobLine({
  label,
  last,
  button,
  busy,
  onRun,
}: {
  label: string;
  last: { runId: string | null; at: string } | null;
  button: string;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <div className="row">
      <span>
        {label} {last ? time(last.at) : <span className="muted">never</span>} {last ? <RunLink runId={last.runId} /> : null}
      </span>
      <button type="button" disabled={busy} onClick={onRun}>
        {button}
      </button>
    </div>
  );
}

export function RunLink({ runId, children }: { runId: string | null; children?: ReactNode }) {
  if (!runId) return null;
  return <a href={`#/runs/${encodeURIComponent(runId)}`}>{children ?? `run ${runId.slice(0, 8)}`}</a>;
}
