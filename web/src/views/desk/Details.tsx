import { useState, type ReactNode } from 'react';
import type {
  DelegationActor,
  DelegationDetail,
  DelegationEvent,
  DelegationLink,
  DelegationNudge,
  DelegationStatus,
} from '../../../../src/dashboard/desk-types';
import { useApi } from '../../api';
import { time } from '../../format';
import { Badge, Button, DetailsPanel, EmptyState, Facts, Section, Skeleton, isNotFound } from '../../ui';
import { DelegationForm } from './DelegationForm';
import { EVENT_LABEL, STATUS_LABEL, STATUS_TONE, detailPath, refreshDesk, updateDelegation } from './data';
import './details.css';

// the details panel of one delegation: its facts, its links (runs, docs, threads, events), its nudge drafts, its
// history oldest first, and the owner's actions (edit, a status change, a note). it renders the DetailsPanel of the
// shell itself and loads GET /api/desk/delegations/:id.
export interface DelegationPanelProps {
  id: number;
  onClose: () => void;
  // a change on the panel calls this, so the board loads again.
  onChanged: () => void;
}

const NOTE_LIMIT = 2_000;
// the counter of the note shows from this length on.
const NOTE_NEAR = 1_800;

const ACTOR_LABEL: Record<DelegationActor, string> = { owner: 'You', agent: 'ok computer', system: 'Follow-up' };

const LINK_KIND_LABEL: Record<string, string> = { run: 'Run', doc: 'Doc', thread: 'Mail thread', event: 'Calendar event' };

// the words of the fields of an updated row, in the order of the form.
const FIELD_LABEL: Record<string, string> = { title: 'title', details: 'details', nextStep: 'next step', dueAt: 'due', nextFollowUpAt: 'follow-up' };

const ACTIVE: readonly DelegationStatus[] = ['open', 'waiting', 'blocked'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const statusWord = (value: unknown): string => {
  const word = text(value);
  return word === null ? '?' : (STATUS_LABEL[word as DelegationStatus] ?? word);
};

function RunLink({ runId, children }: { runId: string; children?: ReactNode }) {
  return <a href={`#/runs/${encodeURIComponent(runId)}`}>{children ?? `run ${runId.slice(0, 8)}`}</a>;
}

// the short words under a history row, from its data. a row whose data has another shape shows no words, so an old
// or a new kind of row never breaks the panel.
export function eventSummary(event: Pick<DelegationEvent, 'kind' | 'data'>): string | null {
  const data = isRecord(event.data) ? event.data : {};
  switch (event.kind) {
    case 'status':
      return data.from === undefined && data.to === undefined ? null : `${statusWord(data.from)} → ${statusWord(data.to)}`;
    case 'updated': {
      const changes = isRecord(data.changes) ? Object.keys(data.changes) : [];
      if (!changes.length) return null;
      return changes.map((field) => FIELD_LABEL[field] ?? field).join(', ');
    }
    case 'waiting_on':
      return text(data.name) ?? text(data.email) ?? 'No one';
    case 'link_added':
    case 'link_removed': {
      const kind = text(data.kind);
      const what = text(data.label) ?? text(data.ref);
      if (!kind && !what) return null;
      return [kind ? (LINK_KIND_LABEL[kind] ?? kind) : null, what].filter(Boolean).join(': ');
    }
    case 'reply_seen': {
      const from = text(data.from);
      return from ? `from ${from}` : null;
    }
    default:
      return null;
  }
}

function HistoryRow({ event }: { event: DelegationEvent }) {
  const label = (EVENT_LABEL as Record<string, string | undefined>)[event.kind] ?? String(event.kind);
  const actor = (ACTOR_LABEL as Record<string, string | undefined>)[event.actor] ?? null;
  let summary: string | null = null;
  try {
    summary = eventSummary(event);
  } catch {
    summary = null;
  }
  return (
    <li className="desk-history-row">
      <div className="desk-history-head">
        <span className="desk-history-kind">{label}</span>
        {actor ? <span className="desk-history-actor">{actor}</span> : null}
        <time className="desk-history-time" dateTime={event.createdAt}>
          {time(event.createdAt)}
        </time>
      </div>
      {event.text ? <p className="desk-history-text">{event.text}</p> : null}
      {summary ? <p className="desk-history-summary">{summary}</p> : null}
      {event.runId ? (
        <p className="desk-history-run">
          <RunLink runId={event.runId} />
        </p>
      ) : null}
    </li>
  );
}

function LinkRow({ link }: { link: DelegationLink }) {
  if (link.kind === 'run') {
    const href = link.href ? `#/${link.href}` : `#/runs/${encodeURIComponent(link.ref)}`;
    return (
      <li className="desk-link">
        <a href={href}>{link.label ?? `Run ${link.ref}`}</a>
      </li>
    );
  }
  if (link.kind === 'doc') {
    return (
      <li className="desk-link">
        <a href={`#/docs/${encodeURIComponent(link.ref)}`}>{link.label ?? `Doc ${link.ref}`}</a>
      </li>
    );
  }
  // a mail thread and a calendar event have no page in the web app, so they show as text with their id.
  const what = link.kind === 'thread' ? 'Mail thread' : link.kind === 'event' ? 'Calendar event' : String(link.kind);
  return (
    <li className="desk-link">
      {link.label ? <span className="desk-link-label">{link.label}</span> : null}
      <span className="desk-link-meta">
        {link.account ? `${what} in ${link.account}` : what} <code>{link.ref}</code>
      </span>
    </li>
  );
}

function NudgeRow({ nudge }: { nudge: DelegationNudge }) {
  return (
    <li className="desk-nudge">
      <Facts
        layout="columns"
        items={[
          { label: 'To', value: nudge.toAddress },
          { label: 'Subject', value: nudge.subject },
          { label: 'Created', value: time(nudge.createdAt) },
        ]}
      />
      <div className="desk-quiet">{nudge.body}</div>
    </li>
  );
}

// the accounts of the nudges in words, for example "personal" or "personal and school".
function accountsOf(nudges: DelegationNudge[]): string {
  const accounts = [...new Set(nudges.map((nudge) => nudge.account))];
  return accounts.length <= 1 ? (accounts[0] ?? '') : `${accounts.slice(0, -1).join(', ')} and ${accounts.at(-1)}`;
}

function NoteForm({ id, onAdded }: { id: number; onAdded: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = note.trim().length;
  const over = note.length > NOTE_LIMIT;
  const submit = () => {
    if (busy || !length || over) return;
    setBusy(true);
    setError(null);
    updateDelegation(id, { note: note.trim() }).then(
      () => {
        setBusy(false);
        setNote('');
        onAdded();
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  return (
    <form
      className="desk-note-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="desk-field-head">
        <label className="desk-label" htmlFor={`desk-note-${id}`}>
          Add a note
        </label>
        {note.length >= NOTE_NEAR ? (
          <span className={`desk-counter${over ? ' is-over' : ''}`} aria-live="polite">
            {note.length}/{NOTE_LIMIT}
          </span>
        ) : null}
      </div>
      <textarea id={`desk-note-${id}`} rows={3} value={note} onChange={(event) => setNote(event.target.value)} aria-invalid={over || undefined} />
      {error !== null ? (
        <p className="desk-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" busy={busy} disabled={!length || over}>
          Add note
        </Button>
      </div>
    </form>
  );
}

function DelegationBody({ detail, onChanged, reload }: { detail: DelegationDetail; onChanged: () => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = () => {
    onChanged();
    reload();
  };
  const move = (status: DelegationStatus) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    updateDelegation(detail.id, { status }).then(
      () => {
        setBusy(false);
        changed();
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  const active = ACTIVE.includes(detail.status);
  const history = Array.isArray(detail.history) ? detail.history : [];
  const nudges = Array.isArray(detail.nudges) ? detail.nudges : [];
  const links = Array.isArray(detail.links) ? detail.links : [];
  const waiting = detail.waitingOn ? [detail.waitingOn.name, detail.waitingOn.email].filter(Boolean).join(' · ') : '';

  return (
    <>
      <div className="desk-status-actions" role="group" aria-label="status actions">
        {active ? (
          <>
            <Button size="sm" icon="check" disabled={busy} onClick={() => move('done')}>
              Mark done
            </Button>
            {detail.status === 'blocked' ? (
              <Button size="sm" disabled={busy} onClick={() => move('open')}>
                Open again
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => move('blocked')}>
                Needs you
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => move('dropped')}>
              Drop
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => move('open')}>
            Open again
          </Button>
        )}
      </div>
      {error !== null ? (
        <p className="error-box" role="alert">
          {error}
        </p>
      ) : null}
      <Facts
        layout="stacked"
        items={[
          { label: 'Status', value: <Badge tone={STATUS_TONE[detail.status] ?? 'muted'}>{STATUS_LABEL[detail.status] ?? detail.status}</Badge> },
          waiting ? { label: 'Waiting on', value: waiting } : null,
          detail.waitingSince ? { label: 'Waiting since', value: time(detail.waitingSince) } : null,
          detail.dueAt ? { label: 'Due', value: time(detail.dueAt) } : null,
          detail.nextFollowUpAt ? { label: 'Next follow-up', value: time(detail.nextFollowUpAt) } : null,
          detail.lastCheckedAt ? { label: 'Last checked', value: time(detail.lastCheckedAt) } : null,
          detail.nudgeCount > 0 ? { label: 'Nudges', value: String(detail.nudgeCount) } : null,
          { label: 'Created', value: `${detail.createdBy === 'owner' ? 'by you' : 'by ok computer'}, ${time(detail.createdAt)}` },
          detail.closedAt ? { label: 'Closed', value: time(detail.closedAt) } : null,
        ]}
      />
      {detail.nextStep ? (
        <div className="desk-block">
          <h3 className="desk-subhead">Next step</h3>
          <p className="desk-next">{detail.nextStep}</p>
        </div>
      ) : null}
      {detail.details ? (
        <div className="desk-block">
          <h3 className="desk-subhead">Details</h3>
          <div className="desk-pre">{detail.details}</div>
        </div>
      ) : null}
      <Section title="Links">
        {links.length ? (
          <ul className="desk-links">
            {links.map((link) => (
              <LinkRow key={`${link.kind}:${link.account ?? ''}:${link.ref}`} link={link} />
            ))}
          </ul>
        ) : (
          <p className="muted">No links</p>
        )}
      </Section>
      {nudges.length ? (
        <Section title="Nudge drafts">
          <ul className="desk-nudges">
            {nudges.map((nudge) => (
              <NudgeRow key={nudge.id} nudge={nudge} />
            ))}
          </ul>
          <p className="desk-note">Saved in the Gmail Drafts of {accountsOf(nudges)}. ok computer never sends it.</p>
        </Section>
      ) : null}
      <Section title="History">
        {history.length ? (
          <ol className="desk-history">
            {history.map((event, index) => (
              <HistoryRow key={event?.id ?? index} event={event} />
            ))}
          </ol>
        ) : (
          <p className="muted">No history yet.</p>
        )}
        <NoteForm id={detail.id} onAdded={changed} />
      </Section>
    </>
  );
}

function Panel({ id, onClose, onChanged }: DelegationPanelProps) {
  const detail = useApi<DelegationDetail>(detailPath(id), refreshDesk);
  const [editing, setEditing] = useState(false);
  const data = detail.data;

  if (detail.error !== undefined && data === undefined) {
    const missing = isNotFound(detail.error);
    return (
      <DetailsPanel title="Delegation" openKey={id} onClose={onClose}>
        {missing ? (
          <EmptyState icon="desk" title="This delegation is not on the desk." action={<Button onClick={onClose}>Close</Button>}>
            It may be an old link. The board shows every delegation.
          </EmptyState>
        ) : (
          <div className="error-box desk-detail-error" role="alert">
            <p>Could not load the delegation: {detail.error}</p>
            <Button size="sm" onClick={detail.reload}>
              Try again
            </Button>
          </div>
        )}
      </DetailsPanel>
    );
  }
  if (data === undefined) {
    return (
      <DetailsPanel title="Delegation" openKey={id} onClose={onClose}>
        <Skeleton lines={8} label="Loading the delegation…" />
      </DetailsPanel>
    );
  }
  const title = <span title={data.title}>{data.title}</span>;
  if (editing) {
    return (
      <DetailsPanel title={title} openKey={id} onClose={onClose}>
        <DelegationForm
          mode="edit"
          delegation={data}
          onDone={() => {
            setEditing(false);
            onChanged();
            detail.reload();
          }}
          onCancel={() => setEditing(false)}
        />
      </DetailsPanel>
    );
  }
  return (
    <DetailsPanel
      title={title}
      openKey={id}
      onClose={onClose}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
      }
    >
      <DelegationBody detail={data} onChanged={onChanged} reload={detail.reload} />
    </DetailsPanel>
  );
}

// the panel starts again for each delegation, so an edit, an error or a note of one never shows on another.
export function DelegationPanel(props: DelegationPanelProps) {
  return <Panel key={props.id} {...props} />;
}
