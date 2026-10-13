import type { ContextMessage, EventRow } from '../../src/dashboard/types';
import { Expand, Json } from './components';
import { time, tokens } from './format';

type Payload = Record<string, unknown>;
const text = (payload: Payload, key = 'text') => String(payload[key] ?? '');

// the raw log shows each event as it is stored. a compaction and a reset show as markers across the log.
export function EventView({ event, summarized = false }: { event: EventRow; summarized?: boolean }) {
  const payload = event.payload;
  const head = (
    <div className="event-head">
      <span className="event-type">
        {event.type.replace('_', ' ')}
        {summarized ? <span className="muted"> · summarized</span> : null}
      </span>
      <span className="muted">
        #{event.seq} {time(event.createdAt)}
        {event.runId ? (
          <>
            {' '}
            · <a href={`#/runs/${encodeURIComponent(event.runId)}`}>run {event.runId.slice(0, 8)}</a>
          </>
        ) : null}
      </span>
    </div>
  );
  switch (event.type) {
    case 'compaction':
      return (
        <div className="event marker">
          {head}
          <p>
            Compaction: {tokens(Number(payload.tokensBefore))} → {tokens(Number(payload.tokensAfter))} estimated tokens. The
            model sees the summary in place of the summarized events above.
          </p>
          <Expand label="summary">{() => <Json value={text(payload, 'summary')} />}</Expand>
        </div>
      );
    case 'session_reset':
      return (
        <div className="event marker">
          {head}
          <p>The owner started a new session here. The model does not see the events above.</p>
        </div>
      );
    case 'assistant_message': {
      const calls = (payload.toolCalls as Array<{ id: string; name: string; input: unknown }>) ?? [];
      return (
        <div className="event role-assistant">
          {head}
          {text(payload) ? <p className="message">{text(payload)}</p> : null}
          {calls.map((call) => (
            <Expand key={call.id} label={`tool call ${call.name}`}>
              {() => <Json value={call.input} />}
            </Expand>
          ))}
          <div className="muted small">
            {String(payload.provider)}/{String(payload.model)} · {String(payload.stopReason)}
          </div>
        </div>
      );
    }
    case 'tool_result':
      return (
        <div className={`event role-tool${payload.isError ? ' is-error' : ''}`}>
          {head}
          <Expand label={`${text(payload, 'name')} result${payload.isError ? ' (error)' : ''}`}>
            {() => <Json value={text(payload, 'content')} />}
          </Expand>
        </div>
      );
    case 'context':
      return (
        <div className="event role-system">
          {head}
          <Expand label="volatile context">{() => <Json value={text(payload)} />}</Expand>
        </div>
      );
    default:
      return (
        <div className={`event ${event.type === 'user_message' ? 'role-user' : 'role-system'}`}>
          {head}
          <p className="message">{text(payload)}</p>
        </div>
      );
  }
}

export function ContextMessageView({ message, index }: { message: ContextMessage; index: number }) {
  if (message.role === 'assistant') {
    return (
      <div className="event role-assistant">
        <div className="event-head">
          <span className="event-type">assistant</span>
          <span className="muted">message {index + 1}</span>
        </div>
        {message.text ? <p className="message">{message.text}</p> : null}
        {message.toolCalls.map((call) => (
          <Expand key={call.id} label={`tool call ${call.name}`}>
            {() => <Json value={call.input} />}
          </Expand>
        ))}
        <Expand label="provider blocks">{() => <Json value={message.content} />}</Expand>
      </div>
    );
  }
  return (
    <div className="event role-user">
      <div className="event-head">
        <span className="event-type">user</span>
        <span className="muted">message {index + 1}</span>
      </div>
      {message.content.map((block, i) =>
        block.type === 'text' ? (
          <pre key={i} className="block">
            {block.text}
          </pre>
        ) : (
          <Expand key={i} label={`tool result ${block.toolCallId}${block.isError ? ' (error)' : ''}`}>
            {() => <Json value={block.content} />}
          </Expand>
        ),
      )}
    </div>
  );
}
