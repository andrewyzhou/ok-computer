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

function chatsPath(filter: string, cursor?: string): string {
  const query = new URLSearchParams({ kind: 'main' });
  if (filter) query.set('q', filter);
  if (cursor) query.set('cursor', cursor);
  query.set('limit', '30');
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
  const [page, setPage] = useState<{ chats: ChatRow[]; nextCursor: string | null } | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [version, setVersion] = useState(0);
  const open = openKey(useHash());
  const needle = filter.trim();
  const refresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        api<ChatsPage>(chatsPath(needle), { signal: controller.signal }).then(
          (loaded) => {
            setPage(loaded);
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
    setMore(true);
    api<ChatsPage>(chatsPath(needle, page.nextCursor)).then(
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
