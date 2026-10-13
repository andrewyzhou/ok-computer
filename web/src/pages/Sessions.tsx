import { useState } from 'react';
import type { ContextView, EventRow, SessionRow } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Empty, Expand, Json, Load, Page, Panel } from '../components';
import { ContextMessageView, EventView } from '../events';
import { time, tokens } from '../format';
import { sessionHref } from './Runs';

export function Sessions() {
  const loaded = useApi<SessionRow[]>('/api/sessions', (message) => message.kind === 'run');
  return (
    <Page title="Sessions">
      <Load loaded={loaded}>
        {(sessions) =>
          sessions.length ? (
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th className="num">Events</th>
                  <th className="num">Compactions</th>
                  <th>First event</th>
                  <th>Last event</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.sessionKey}>
                    <td>
                      <a href={sessionHref(session.sessionKey)}>{session.sessionKey}</a>
                    </td>
                    <td className="num">{session.events}</td>
                    <td className="num">{session.compactions}</td>
                    <td>{time(session.firstAt)}</td>
                    <td>{time(session.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No sessions yet.</Empty>
          )
        }
      </Load>
    </Page>
  );
}

function ModelView({ sessionKey }: { sessionKey: string }) {
  const loaded = useApi<ContextView>(
    `/api/sessions/${encodeURIComponent(sessionKey)}/context`,
    (message) => message.kind === 'event' && message.event.sessionKey === sessionKey,
  );
  return (
    <Load loaded={loaded}>
      {(view) => (
        <>
          <p className="muted small">
            The context strategy gives this input to the next model call: about {tokens(view.estimatedTokens)} tokens.
          </p>
          <Expand label="system prompt">{() => <Json value={view.system} />}</Expand>
          <Expand label={`${view.tools.length} tools`}>
            {() => (
              <ul className="list">
                {view.tools.map((tool) => (
                  <li key={tool.name}>
                    <strong>{tool.name}</strong>: {tool.description}
                  </li>
                ))}
              </ul>
            )}
          </Expand>
          <div className="log">
            {view.messages.map((message, i) => (
              <ContextMessageView key={i} message={message} index={i} />
            ))}
          </div>
        </>
      )}
    </Load>
  );
}

// a compaction replaces the events before its first kept event with a summary. a reset hides all events before it, so
// the events before a reset are not marked.
function summarizedIds(events: EventRow[]): Set<number> {
  const ids = new Set<number>();
  for (const compaction of events.filter((event) => event.type === 'compaction')) {
    const firstKept = Number(compaction.payload.firstKeptEventId);
    const reset = events.findLast((event) => event.type === 'session_reset' && event.id < compaction.id);
    for (const event of events) {
      if (event.id < firstKept && (!reset || event.id > reset.id)) ids.add(event.id);
    }
  }
  return ids;
}

export function SessionDetail({ sessionKey }: { sessionKey: string }) {
  const [showModel, setShowModel] = useState(false);
  const loaded = useApi<EventRow[]>(
    `/api/sessions/${encodeURIComponent(sessionKey)}/events`,
    (message) => message.kind === 'event' && message.event.sessionKey === sessionKey,
  );
  return (
    <Page
      title={`Session ${sessionKey}`}
      actions={
        <label className="toggle">
          <input type="checkbox" checked={showModel} onChange={(event) => setShowModel(event.target.checked)} />
          Show what the model saw
        </label>
      }
    >
      <div className={showModel ? 'split' : ''}>
        <Panel title="Raw log">
          <Load loaded={loaded}>
            {(events) => {
              const summarized = summarizedIds(events);
              return (
                <div className="log">
                  {events.map((event) => (
                    <div key={event.id} className={summarized.has(event.id) ? 'summarized' : undefined}>
                      <EventView event={event} summarized={summarized.has(event.id)} />
                    </div>
                  ))}
                </div>
              );
            }}
          </Load>
        </Panel>
        {showModel ? (
          <Panel title="What the model saw">
            <ModelView sessionKey={sessionKey} />
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
