import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatSendResponse, ChatStopResponse } from '../../../../src/dashboard/types';
import { send } from '../../api';
import { applyTurnAction, type LiveTurn } from '../../chat-stream';
import { Button } from '../../ui';

// the limit of the contract for one owner message.
export const MAX_TEXT = 16_000;
// the counter shows only near the limit, so a short message has a calm composer.
const COUNTER_FROM = 15_000;

// the server says 503 when the web channel is not running. the page says it in the words of the owner.
function sendError(err: Error): string {
  if (/^503\b|not running/i.test(err.message)) return 'the web channel is not running';
  return err.message;
}

// the box to write to the agent. Enter sends and Shift+Enter starts a new line. the draft stays after an error, so
// the owner can send it again.
export function Composer({ active, onSent }: { active: LiveTurn | undefined; onSent?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [note, setNote] = useState('');
  const counterId = useId();
  const length = text.length;
  const empty = text.trim().length === 0;
  const tooLong = length > MAX_TEXT;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (empty || tooLong || busy) return;
    setBusy(true);
    setError('');
    setNote('');
    const sentText = text;
    send<ChatSendResponse>('/api/chat', 'POST', { text: sentText }).then(
      (sent) => {
        applyTurnAction({ kind: 'sent', turnId: sent.turnId, text: sentText, state: sent.state });
        // the box stays editable during the request. a follow-up that the owner wrote meanwhile stays in the box.
        setText((current) => (current === sentText ? '' : current));
        setBusy(false);
        onSent?.();
      },
      (err: Error) => {
        setError(sendError(err));
        setBusy(false);
      },
    );
  };

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const stop = () => {
    if (!active) return;
    setStopping(true);
    setNote('');
    send<ChatStopResponse>('/api/chat/stop', 'POST', { turnId: active.turnId }).then(
      (result) => {
        setStopping(false);
        if (!result.stopped) setNote('the turn already ended');
      },
      (err: Error) => {
        setStopping(false);
        setError(err.message);
      },
    );
  };

  return (
    <form className="chat-composer" onSubmit={submit} aria-label="new message">
      <textarea
        className="chat-input"
        aria-label="Message"
        aria-describedby={length >= COUNTER_FROM ? counterId : undefined}
        aria-invalid={tooLong || undefined}
        placeholder="Write to ok computer"
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keys}
      />
      <div className="chat-composer-bar">
        <div className="chat-composer-info">
          {length >= COUNTER_FROM ? (
            <span id={counterId} className={tooLong ? 'chat-counter error-text' : 'chat-counter muted'}>
              {length.toLocaleString('en-US')} / {MAX_TEXT.toLocaleString('en-US')}
              {tooLong ? ', too long to send' : ''}
            </span>
          ) : (
            <span className="chat-hint muted">Enter sends, Shift+Enter adds a line</span>
          )}
          {error ? (
            <span role="alert" className="error-text">
              {error}
            </span>
          ) : null}
          {note ? (
            <span role="status" className="muted">
              {note}
            </span>
          ) : null}
        </div>
        {active ? (
          <Button variant="secondary" icon="stop" busy={stopping} onClick={stop}>
            Stop
          </Button>
        ) : null}
        <Button variant="primary" icon="send" type="submit" busy={busy} disabled={empty || tooLong}>
          Send
        </Button>
      </div>
    </form>
  );
}
