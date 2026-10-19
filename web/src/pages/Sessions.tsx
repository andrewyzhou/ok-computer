import { useEffect, useRef, useState } from 'react';
import type { ContextView, EventRow, SessionRow, StreamMessage } from '../../../src/dashboard/types';
import { useApi, type Loaded } from '../api';
import { Expand, Load } from '../components';
import { ContextMessageView, EventView } from '../events';
import { time, tokens } from '../format';
import type { RouteProps } from '../routes';
import { useDevMode } from '../shell/prefs';
import { Button, ButtonLink, CodeBlock, DetailsPanel, EmptyState, Facts, FilterBar, Page, SearchField, Section, Table, type Column } from '../ui';
import { sessionHref } from './Runs';
import './dev.css';

const COLUMNS: Array<Column<SessionRow>> = [
  {
    key: 'key',
    header: 'Session',
    cell: (session) => <a href={sessionHref(session.sessionKey)}>{session.sessionKey}</a>,
    wrap: true,
  },
  { key: 'events', header: 'Events', cell: (session) => session.events, align: 'end' },
  { key: 'compactions', header: 'Compactions', cell: (session) => session.compactions, align: 'end', hideBelow: 'sm' },
  { key: 'first', header: 'First event', cell: (session) => time(session.firstAt), hideBelow: 'md' },
  { key: 'last', header: 'Last event', cell: (session) => time(session.lastAt), hideBelow: 'sm' },
];

function SessionsBody({ sessions, search }: { sessions: SessionRow[]; search: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const needle = search.trim().toLowerCase();
  const rows = needle ? sessions.filter((session) => session.sessionKey.toLowerCase().includes(needle)) : sessions;
  const session = sessions.find((each) => each.sessionKey === selected);
  return (
    <>
      <Table
        label="sessions"
        dense
        columns={COLUMNS}
        rows={rows}
        rowKey={(each) => each.sessionKey}
        selected={selected}
        onSelect={(each) => setSelected(each.sessionKey === selected ? null : each.sessionKey)}
        empty={<EmptyState icon="session" title={sessions.length ? 'No session matches the search.' : 'No sessions yet.'} />}
      />
      {session ? (
        <DetailsPanel title="Session" openKey={session.sessionKey} onClose={() => setSelected(null)}>
          <Facts
            layout="stacked"
            items={[
              { label: 'Key', value: <code className="dev-id">{session.sessionKey}</code> },
              { label: 'Events', value: session.events },
              { label: 'Compactions', value: session.compactions },
              { label: 'First event', value: time(session.firstAt) },
              { label: 'Last event', value: time(session.lastAt) },
            ]}
          />
          <div className="dev-panel-actions">
            <ButtonLink href={sessionHref(session.sessionKey)} size="sm" variant="primary" icon="session">
              Open the session
            </ButtonLink>
            <ButtonLink href={`#/runs?sessionKey=${encodeURIComponent(session.sessionKey)}`} size="sm" icon="run">
              Runs of this session
            </ButtonLink>
          </div>
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Sessions">
          <Facts
            layout="stacked"
            items={[
              { label: 'Sessions', value: sessions.length },
              { label: 'Events', value: sessions.reduce((sum, each) => sum + each.events, 0) },
              { label: 'Compactions', value: sessions.reduce((sum, each) => sum + each.compactions, 0) },
            ]}
          />
          <p className="muted small">Select a session to see its facts.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Sessions(_props: Partial<RouteProps>) {
  const [search, setSearch] = useState('');
  const loaded = useApi<SessionRow[]>('/api/sessions', (message) => message.kind === 'run');
  return (
    <Page
      title="Sessions"
      width="full"
      toolbar={
        <FilterBar>
          <SearchField label="Filter sessions" placeholder="Filter by key" value={search} onChange={setSearch} />
        </FilterBar>
      }
    >
      <Load loaded={loaded}>{(sessions) => <SessionsBody sessions={sessions} search={search} />}</Load>
    </Page>
  );
}

function ModelView({ loaded }: { loaded: Loaded<ContextView> }) {
  return (
    <Load loaded={loaded}>
      {(view) => (
        <>
          <p className="muted small">The context strategy gives this input to the next model call: about {tokens(view.estimatedTokens)} tokens.</p>
          <Expand label="system prompt">{() => <CodeBlock text={view.system} label="system prompt" />}</Expand>
          <Expand label={`${view.tools.length} tools`}>
            {() => (
              <ul className="sessions-tools">
                {view.tools.map((tool) => (
                  <li key={tool.name}>
                    <code className="dev-id">{tool.name}</code> <span className="muted">{tool.description}</span>
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

function SessionPanel({ sessionKey, events, context }: { sessionKey: string; events: EventRow[] | undefined; context: Loaded<ContextView> }) {
  const devMode = useDevMode();
  const view = context.data;
  return (
    <DetailsPanel title="Session">
      <Facts
        layout="stacked"
        items={[
          events && { label: 'Events', value: events.length },
          events && { label: 'Compactions', value: events.filter((event) => event.type === 'compaction').length },
          events && { label: 'First event', value: time(events[0]?.createdAt) },
          events && { label: 'Last event', value: time(events.at(-1)?.createdAt) },
          {
            label: 'Next request, estimated tokens',
            value: view ? tokens(view.estimatedTokens) : context.error ? <span className="error-text">{context.error}</span> : '…',
          },
          view && { label: 'Messages in the next request', value: view.messages.length },
          view && { label: 'Tools offered', value: view.tools.length },
        ]}
      />
      <div className="dev-panel-actions">
        <ButtonLink href={`#/runs?sessionKey=${encodeURIComponent(sessionKey)}`} size="sm" icon="run">
          Runs of this session
        </ButtonLink>
      </div>
      {devMode && view ? <CodeBlock text={view.system} label="system prompt" maxHeight={360} /> : null}
    </DetailsPanel>
  );
}

export function SessionDetail({ sessionKey }: { sessionKey: string; query?: URLSearchParams }) {
  const [showModel, setShowModel] = useState(false);
  const modelView = useRef<HTMLDivElement>(null);
  // on a narrow main area the view goes under the long raw log, so the page scrolls to it. side by side it is in view.
  useEffect(() => {
    const node = modelView.current;
    if (showModel && node && node.getBoundingClientRect().top > innerHeight) node.scrollIntoView?.({ block: 'start' });
  }, [showModel]);
  const about = (message: StreamMessage) => message.kind === 'event' && message.event.sessionKey === sessionKey;
  const loaded = useApi<EventRow[]>(`/api/sessions/${encodeURIComponent(sessionKey)}/events`, about);
  const context = useApi<ContextView>(`/api/sessions/${encodeURIComponent(sessionKey)}/context`, about);
  return (
    <Page
      title={`Session ${sessionKey}`}
      crumbs={[{ label: 'Sessions', href: '#/sessions' }]}
      width="full"
      actions={
        <>
          <ButtonLink href={`#/runs?sessionKey=${encodeURIComponent(sessionKey)}`} size="sm" variant="ghost" icon="run" className="dev-wide-only">
            Runs
          </ButtonLink>
          <Button
            size="sm"
            variant={showModel ? 'primary' : 'secondary'}
            aria-pressed={showModel}
            aria-label="Show what the model saw"
            onClick={() => setShowModel(!showModel)}
          >
            Show what the model saw
          </Button>
        </>
      }
    >
      <SessionPanel sessionKey={sessionKey} events={loaded.data} context={context} />
      <div className={showModel ? 'sessions-split' : undefined}>
        <Section title="Raw log" description="Each event of the session as it is stored, oldest first.">
          <Load loaded={loaded}>
            {(events) => {
              const summarized = summarizedIds(events);
              return events.length ? (
                <div className="log">
                  {events.map((event) => (
                    <div key={event.id} className={summarized.has(event.id) ? 'summarized' : undefined}>
                      <EventView event={event} summarized={summarized.has(event.id)} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon="session" title="This session has no events." />
              );
            }}
          </Load>
        </Section>
        {showModel ? (
          <div ref={modelView} className="sessions-model">
            <Section title="What the model saw">
              <ModelView loaded={context} />
            </Section>
          </div>
        ) : null}
      </div>
    </Page>
  );
}
