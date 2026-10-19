import { useEffect, useState } from 'react';
import type { ChatKind, ChatRow, ChatsPage } from '../../../../src/dashboard/types';
import { api, useStream } from '../../api';
import { time, usd } from '../../format';
import type { RouteProps } from '../../routes';
import { Button, ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, Page, SearchField, Skeleton, Status, Table, Tabs, type Column } from '../../ui';
import { ChatView, chatHref } from '../chats';
import './activity.css';

type Tab = 'all' | Exclude<ChatKind, 'main'>;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'auto', label: 'Automations' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'sub', label: 'Sub-agents' },
  { id: 'consolidate', label: 'Consolidation' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'poll', label: 'Polls' },
  { id: 'other', label: 'Other' },
];

const DEBOUNCE_MS = 200;

function tabOf(query: URLSearchParams): Tab {
  const kind = query.get('kind');
  return TABS.some((tab) => tab.id === kind) ? (kind as Tab) : 'all';
}

function listPath(tab: Tab, q: string, cursor?: string): string {
  const query = new URLSearchParams({ kind: tab === 'all' ? 'activity' : tab });
  if (q) query.set('q', q);
  if (cursor) query.set('cursor', cursor);
  return `/api/chats?${query}`;
}

const COLUMNS: Array<Column<ChatRow>> = [
  {
    key: 'title',
    header: 'Title',
    wrap: true,
    cell: (chat) => (
      <a className="activity-title" href={chatHref(chat.key, 'activity')}>
        {chat.title}
      </a>
    ),
  },
  { key: 'kind', header: 'Kind', cell: (chat) => chat.kind, hideBelow: 'sm' },
  { key: 'last', header: 'Last', cell: (chat) => time(chat.lastAt) },
  { key: 'runs', header: 'Runs', cell: (chat) => chat.runs, align: 'end', hideBelow: 'md' },
  { key: 'cost', header: 'Cost', cell: (chat) => usd(chat.costUsd), align: 'end', hideBelow: 'md' },
  { key: 'status', header: 'Last run', cell: (chat) => (chat.lastRunStatus ? <Status value={chat.lastRunStatus} /> : <span className="muted">none</span>) },
];

function ActivityFacts({ chat }: { chat: ChatRow }) {
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'Kind', value: chat.kind },
          { label: 'Session', value: <span className="activity-key">{chat.sessionKey}</span> },
          { label: 'First', value: time(chat.firstAt) },
          { label: 'Last', value: time(chat.lastAt) },
          { label: 'Runs', value: chat.runs },
          { label: 'Cost', value: usd(chat.costUsd) },
          { label: 'Last run', value: chat.lastRunStatus ? <Status value={chat.lastRunStatus} /> : 'none' },
          chat.pendingApprovals > 0 && { label: 'Pending approvals', value: chat.pendingApprovals },
          chat.preview ? { label: 'Last text', value: <span className="activity-preview">{chat.preview}</span> } : null,
        ]}
      />
      <div>
        <ButtonLink href={chatHref(chat.key, 'activity')} size="sm" icon="chat">
          Open the transcript
        </ButtonLink>
      </div>
    </>
  );
}

// the list of background sessions. the tab is in the hash, so a link or a reload keeps it.
export function ActivityList({ query }: RouteProps) {
  const tab = tabOf(query);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<ChatsPage | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<ChatsPage>(listPath(tab, q), { signal: controller.signal }).then(
      (loaded) => setPage(loaded),
      (err: Error) => !controller.signal.aborted && setError(err.message),
    );
    return () => controller.abort();
  }, [tab, q, version]);

  // a background run that starts or ends changes the list, so it loads again.
  useStream((message) => {
    if (message.kind === 'run' && message.run.sessionKey !== 'main') setVersion((v) => v + 1);
  });

  const choose = (next: Tab) => {
    setSelected(null);
    setPage(null);
    location.hash = next === 'all' ? '#/activity' : `#/activity?kind=${next}`;
  };

  const loadMore = () => {
    if (!page?.nextCursor) return;
    setMore(true);
    api<ChatsPage>(listPath(tab, q, page.nextCursor)).then(
      (next) => {
        setMore(false);
        setPage((old) => ({ chats: [...(old?.chats ?? []), ...next.chats], nextCursor: next.nextCursor }));
      },
      (err: Error) => {
        setMore(false);
        setError(err.message);
      },
    );
  };

  const chat = page?.chats.find((each) => each.key === selected);
  return (
    <Page
      title="Activity"
      subtitle="The sessions that ran in the background."
      toolbar={
        <FilterBar label="activity filters" end={<SearchField label="Search activity" value={text} onChange={setText} />}>
          <Tabs label="kind" items={TABS} value={tab} onChange={choose} />
        </FilterBar>
      }
    >
      {error && !page ? <p className="error-box">Could not load: {error}</p> : null}
      {!page ? (
        error ? null : <Skeleton lines={6} />
      ) : (
        <div className="activity-list">
          <Table
            label="background sessions"
            columns={COLUMNS}
            rows={page.chats}
            rowKey={(each) => each.key}
            selected={selected}
            onSelect={(each) => setSelected(each.key === selected ? null : each.key)}
            empty={<EmptyState icon="activity" title={q ? 'No session matches.' : 'No background session yet.'} />}
          />
          {page.nextCursor ? (
            <div className="activity-more">
              <Button variant="secondary" size="sm" busy={more} onClick={loadMore}>
                Load more
              </Button>
            </div>
          ) : null}
          {error ? <p className="error-text">{error}</p> : null}
        </div>
      )}
      {chat ? (
        <DetailsPanel title={chat.title} openKey={chat.key} onClose={() => setSelected(null)}>
          <ActivityFacts chat={chat} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Activity">
          <p className="muted activity-hint">Select a session to see its facts. The title opens its transcript.</p>
        </DetailsPanel>
      )}
    </Page>
  );
}

// the nav group Activity is the crumb that leads back to the list, so the page adds no crumb of its own.
export function ActivityChat({ chatKey }: { chatKey: string }) {
  return <ChatView chatKey={chatKey} mode="activity" crumbs={[]} />;
}
