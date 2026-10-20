import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { DocComment, DocCommentRequest, DocSummary } from '../../../../src/dashboard/docs-types';
import { send } from '../../api';
import { Button, KeyHint } from '../../ui';
import { docTime } from './parts';
import { docCommentsApi, docHref } from './shared';
import './comments.css';

export interface DocCommentsProps {
  doc: DocSummary;
  // the version on the page. a new comment is about this version.
  version: number;
  comments: DocComment[];
  // the text that the owner selected in the doc, offered as the quote of a new comment. empty when none is selected.
  selection?: string;
  // the page loads the doc again after a comment is added, so the list and the count come from the server.
  onAdded: () => void;
}

// the limits of the contract (COMMENT_CHARS and QUOTE_CHARS of src/docs/comments.ts). the count shows only near the
// limit, so a short comment has a calm form.
export const COMMENT_CHARS = 4_000;
export const QUOTE_CHARS = 500;
const COUNTER_FROM = 3_500;

// the owner's comments on a doc and the form for a new one. the doc page renders it in its details panel, and below
// the doc at 390. each text is the owner's own, and it shows as plain text, never as markdown or html.
export function DocComments({ doc, version, comments, selection = '', onAdded }: DocCommentsProps) {
  return (
    <section className="doc-comments" aria-label="Comments">
      <h2 className="doc-panel-title">
        Comments <span className="doc-panel-count">{comments.length}</span>
      </h2>
      {comments.length ? (
        <ol className="doc-comments-list">
          {comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} shown={version} />
          ))}
        </ol>
      ) : (
        <p className="doc-comments-empty muted">No comments yet. A comment goes to the agent, and it reads it in its next run.</p>
      )}
      <CommentForm docId={doc.id} version={version} selection={selection} onAdded={onAdded} />
    </section>
  );
}

function CommentItem({ comment, shown }: { comment: DocComment; shown: number }) {
  const sent = comment.eventId !== null;
  return (
    <li className="doc-comment">
      {comment.quote ? <blockquote className="doc-comment-quote">{comment.quote}</blockquote> : null}
      <p className="doc-comment-text">{comment.text}</p>
      <div className="doc-comment-meta">
        {comment.version === shown ? (
          <span>on version {comment.version}</span>
        ) : (
          <a href={docHref(comment.docId, comment.version)}>on version {comment.version}</a>
        )}
        <time dateTime={comment.createdAt}>{docTime(comment.createdAt)}</time>
        <span className={sent ? 'doc-comment-state is-sent' : 'doc-comment-state is-waiting'}>{sent ? 'sent to the agent' : 'waits for the agent'}</span>
      </div>
    </li>
  );
}

function CommentForm({ docId, version, selection, onAdded }: { docId: number; version: number; selection: string; onAdded: () => void }) {
  const [text, setText] = useState('');
  const [quote, setQuote] = useState(selection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const counterId = useId();

  // a new selection in the doc replaces the quote, and an empty one leaves the quote that the owner kept.
  useEffect(() => {
    if (selection.trim()) setQuote(selection);
  }, [selection]);

  const shownQuote = quote.trim().slice(0, QUOTE_CHARS);
  const empty = text.trim().length === 0;
  const counted = text.length > COUNTER_FROM;
  const tooLong = text.length > COMMENT_CHARS;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (empty || busy) return;
    setBusy(true);
    setError('');
    const body: DocCommentRequest = { text, version, ...(shownQuote ? { quote: shownQuote } : {}) };
    send<DocComment>(docCommentsApi(docId), 'POST', body).then(
      () => {
        setBusy(false);
        setText('');
        setQuote('');
        onAdded();
      },
      // the text stays after an error, so the owner can fix it and send it again.
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form className="doc-comment-form" onSubmit={submit} aria-label="New comment">
      <label className="doc-comment-label" htmlFor={inputId}>
        Comment on version {version}
      </label>
      {shownQuote ? (
        <div className="doc-comment-quote-preview">
          <blockquote className="doc-comment-quote">{shownQuote}</blockquote>
          <Button variant="ghost" size="sm" icon="close" onClick={() => setQuote('')}>
            Remove quote
          </Button>
        </div>
      ) : null}
      <textarea
        id={inputId}
        className="doc-comment-input"
        rows={3}
        value={text}
        placeholder="What should change?"
        aria-describedby={counted ? counterId : undefined}
        aria-invalid={tooLong || undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keys}
      />
      <div className="doc-comment-bar">
        <div className="doc-comment-info">
          {counted ? (
            <span id={counterId} className={tooLong ? 'doc-comment-counter error-text' : 'doc-comment-counter muted'}>
              {text.length.toLocaleString('en-US')} / {COMMENT_CHARS.toLocaleString('en-US')}
            </span>
          ) : (
            <span className="doc-comment-hint muted">
              <KeyHint keys={['mod', 'enter']} label="Command or Control and Enter" /> sends
            </span>
          )}
          {busy ? (
            <span role="status" className="muted">
              Sending…
            </span>
          ) : null}
          {error ? (
            <span role="alert" className="error-text">
              {error}
            </span>
          ) : null}
        </div>
        <Button variant="primary" icon="send" type="submit" busy={busy} disabled={empty}>
          Comment
        </Button>
      </div>
    </form>
  );
}
