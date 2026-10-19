import { useState } from 'react';
import { send } from '../api';
import { time } from '../format';
import { Status } from './Badge';
import { Button } from './Button';

// the fields of an approval that a card needs. an ApprovalRow and a StreamApproval both have them.
export interface ApprovalLike {
  id: number;
  runId: string;
  toolName: string;
  summary: string;
  status: string;
  requestedAt: string;
}

// one approval with its buttons, for the approvals page, a chat and the inbox views. the card shows the redacted
// summary only, never the stored input. after a decision it shows the answer of the server, and onDecided lets the
// view load its data again.
export function ApprovalCard({ approval, onDecided, compact }: { approval: ApprovalLike; onDecided?: (message: string) => void; compact?: boolean }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [answer, setAnswer] = useState<{ text: string; error: boolean } | null>(null);
  const [decided, setDecided] = useState(false);
  const decide = (decision: 'approve' | 'deny') => {
    setBusy(decision);
    send<{ message: string }>(`/api/approvals/${approval.id}`, 'POST', { decision }).then(
      (result) => {
        setBusy(null);
        setDecided(true);
        setAnswer({ text: result.message, error: false });
        onDecided?.(result.message);
      },
      (err: Error) => {
        setBusy(null);
        setAnswer({ text: err.message, error: true });
      },
    );
  };
  const pending = approval.status === 'pending' && !decided;
  return (
    <article className={compact ? 'approval-card is-compact' : 'approval-card'} aria-label={`approval #${approval.id}`}>
      <header className="approval-head">
        <strong>#{approval.id}</strong>
        <span>{approval.toolName}</span>
        <Status value={approval.status} />
        <span className="muted approval-time">{time(approval.requestedAt)}</span>
      </header>
      <pre className="approval-summary">{approval.summary}</pre>
      <footer className="approval-foot">
        {pending ? (
          <>
            <Button variant="primary" size="sm" icon="check" busy={busy === 'approve'} disabled={busy !== null} onClick={() => decide('approve')}>
              Approve
            </Button>
            <Button variant="secondary" size="sm" busy={busy === 'deny'} disabled={busy !== null} onClick={() => decide('deny')}>
              Deny
            </Button>
          </>
        ) : null}
        <a className="approval-run" href={`#/runs/${encodeURIComponent(approval.runId)}`}>
          run {approval.runId.slice(0, 8)}
        </a>
        {answer ? (
          <span role="status" className={answer.error ? 'error-text' : 'muted'}>
            {answer.text}
          </span>
        ) : null}
      </footer>
    </article>
  );
}
