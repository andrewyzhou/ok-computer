import { useEffect, useRef, useState } from 'react';
import type { ChatRow, ChatsPage } from '../../../../src/dashboard/types';
import { api, useStream } from '../../api';
import { useChatStream } from '../../chat-stream';
import { clock } from '../../format';
import { defineShellExtension, type NavPanelProps } from '../../shell/extensions';
import { Button, Count, Status } from '../../ui';
import { chatHref, useHash } from './data';
import './chats.css';

// the text of the nav search waits this long after the last key, so a word gives one request.
const DEBOUNCE_MS = 200;
// a burst of stream events gives one reload of the list.
const REFRESH_MS = 300;

const PAGE_SIZE = 30;
// the server gives at most 200 rows in one page.
const MAX_LIMIT = 200;

function chatsPath(filter: string, cursor?: string, limit = PAGE_SIZE): string {
  const query = new URLSearchParams({ kind: 'main' });
  if (filter) query.set('q', filter);
  if (cursor) query.set('cursor', cursor);
  query.set('limit', String(limit));
  return `/api/chats?${query}`;
}

// the key of the open chat, from a hash such as #/chats/main%400. a hash with the key not encoded matches too.
function openKey(hash: string): string | null {
  const found = /^#\/chats\/([^?/]+)/.exec(hash);
  if (!found) return null;
  try {
    return decodeURIComponent(found[1]!);
  } catch {
    return found[1]!;
  }
}

function ChatLink({ chat, current, onNavigate }: { chat: ChatRow; current: boolean; onNavigate: () => void }) {
  return (
    <li>
      <a className={current ? 'chat-nav-item is-on' : 'chat-nav-item'} href={chatHref(chat.key)} aria-current={current ? 'page' : undefined} onClick={onNavigate}>
        <span className="chat-nav-top">
          <span className="chat-nav-title">{chat.title}</span>
          <time className="chat-nav-time" dateTime={chat.lastAt}>
            {clock(chat.lastAt)}
          </time>
        </span>
        <span className="chat-nav-bottom">
          <span className="chat-nav-preview">{chat.preview ?? ''}</span>
          {chat.lastRunStatus === 'running' ? <Status value="running" /> : null}
          <Count value={chat.pendingApprovals} label="pending approvals" />
        </span>
      </a>
    </li>
  );
}

// the main chats under the Chats heading of the nav, newest first. the search field of the nav filters them on the
// server, by title and preview.
export function ChatNavList({ filter, onNavigate }: NavPanelProps) {
  // the page keeps the filter it is for, so an answer for an older filter never joins the list of a newer one.
  const [page, setPage] = useState<{ filter: string; chats: ChatRow[]; nextCursor: string | null } | null>(null);
  const shown = useRef({ filter: '', count: 0 });
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [version, setVersion] = useState(0);
  const open = openKey(useHash());
  const needle = filter.trim();
  const refresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  if (page) shown.current = { filter: page.filter, count: page.chats.length };

  useEffect(() => {
    const controller = new AbortController();
    // a reload from the stream asks for as many rows as the list shows, so the rows of Load more stay.
    const limit = shown.current.filter === needle ? Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, shown.current.count)) : PAGE_SIZE;
    const timer = setTimeout(
      () =>
        api<ChatsPage>(chatsPath(needle, undefined, limit), { signal: controller.signal }).then(
          (loaded) => {
            setPage({ filter: needle, chats: loaded.chats, nextCursor: loaded.nextCursor });
            setError('');
          },
          (err: Error) => !controller.signal.aborted && setError(err.message),
        ),
      version === 0 && !needle ? 0 : DEBOUNCE_MS,
    );
    // a new text aborts the request of the older one, so a slow answer never replaces a newer list.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [needle, version]);
  useEffect(() => () => clearTimeout(refresh.current), []);

  const reload = () => {
    if (refresh.current) return;
    refresh.current = setTimeout(() => {
      refresh.current = undefined;
      setVersion((v) => v + 1);
    }, REFRESH_MS);
  };
  // the chat stream subscribes first. the older web tests take the last stream that the page opened as the main one.
  useChatStream((event) => (event.kind === 'owner' || event.kind === 'done') && reload());
  useStream((message) => message.kind === 'run' && reload());

  const loadMore = () => {
    if (!page?.nextCursor) return;
    const asked = page.filter;
    setMore(true);
    api<ChatsPage>(chatsPath(asked, page.nextCursor)).then(
      (next) => {
        setMore(false);
        setPage((old) => (old && old.filter === asked ? { ...old, chats: [...old.chats, ...next.chats], nextCursor: next.nextCursor } : old));
      },
      (err: Error) => {
        setMore(false);
        setError(err.message);
      },
    );
  };

  if (!page) return error ? <p className="chat-nav-none">Chats could not load.</p> : null;
  return (
    <div className="chat-nav" data-testid="chat-nav">
      {page.chats.length ? (
        <ul className="chat-nav-list" aria-label="chats">
          {page.chats.map((chat) => (
            <ChatLink key={chat.key} chat={chat} current={open === chat.key} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : (
        <p className="chat-nav-none">No chat matches.</p>
      )}
      {page.nextCursor ? (
        <Button variant="ghost" size="sm" className="chat-nav-more" busy={more} onClick={loadMore}>
          Load more
        </Button>
      ) : null}
      {error ? <p className="chat-nav-none error-text">{error}</p> : null}
    </div>
  );
}

export default defineShellExtension({ navPanels: [{ group: 'chats', Component: ChatNavList }] });
