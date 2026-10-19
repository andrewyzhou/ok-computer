import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMessagesPage, ChatRow, RunDetail, ToolCallRow } from '../../../../src/dashboard/types';
import { api } from '../../api';

// the data parts of the chat views: the links, the paged transcript and the tool calls of a run.

// a chat key holds a colon and an at sign, for example main@0, so each link encodes it.
export function chatHref(key: string, area: 'chats' | 'activity' = 'chats'): string {
  return `#/${area}/${encodeURIComponent(key)}`;
}

export function messagesPath(key: string, before?: number): string {
  const query = new URLSearchParams({ limit: '50' });
  if (before !== undefined) query.set('before', String(before));
  return `/api/chats/${encodeURIComponent(key)}/messages?${query}`;
}

export function useHash(): string {
  const [hash, setHash] = useState(() => globalThis.location?.hash ?? '');
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export interface Transcript {
  chat?: ChatRow;
  messages: ChatMessage[];
  // the value for the next older page, or null when the transcript starts here.
  before: number | null;
  error?: string;
  notFound: boolean;
  olderBusy: boolean;
  olderError?: string;
  // it gives false when nothing changed.
  loadOlder(): Promise<boolean>;
  // the newest page again, after a turn ended or the session was reset. the older pages that the page loaded stay. it
  // gives the page, or null when the load failed, and then error holds the reason.
  reloadNewest(): Promise<ChatMessagesPage | null>;
}

export function useTranscript(key: string): Transcript {
  const [state, setState] = useState<{ chat?: ChatRow; messages: ChatMessage[]; before: number | null; error?: string; notFound: boolean }>({
    messages: [],
    before: null,
    notFound: false,
  });
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reloadNewest = useCallback(
    () =>
      api<ChatMessagesPage>(messagesPath(key)).then(
        (page) => {
          if (!alive.current) return null;
          setState((old) => {
            const first = page.messages[0]?.id;
            // the older messages that the page loaded before stay in front of the new page.
            const kept = first === undefined || !old.chat ? [] : old.messages.filter((message) => message.id < first);
            return {
              chat: page.chat,
              messages: [...kept, ...page.messages],
              before: kept.length ? old.before : page.before,
              notFound: false,
            };
          });
          return page;
        },
        (err: Error) => {
          if (!alive.current) return null;
          setState((old) => ({ ...old, error: err.message, notFound: /not found/i.test(err.message) }));
          return null;
        },
      ),
    [key],
  );

  useEffect(() => {
    void reloadNewest();
  }, [reloadNewest]);

  const loadOlder = useCallback(async () => {
    if (state.before === null) return false;
    setOlderBusy(true);
    setOlderError(undefined);
    try {
      const page = await api<ChatMessagesPage>(messagesPath(key, state.before));
      if (!alive.current) return false;
      setState((old) => {
        const have = new Set(old.messages.map((message) => message.id));
        return { ...old, chat: page.chat, messages: [...page.messages.filter((message) => !have.has(message.id)), ...old.messages], before: page.before };
      });
      return page.messages.length > 0;
    } catch (err) {
      if (alive.current) setOlderError((err as Error).message);
      return false;
    } finally {
      if (alive.current) setOlderBusy(false);
    }
  }, [key, state.before]);

  return { ...state, olderBusy, ...(olderError !== undefined ? { olderError } : {}), loadOlder, reloadNewest };
}

// the tool calls of a run, in the order of the timeline. the child runs of a delegate call stay on their own page.
export function toolCallsOf(detail: RunDetail): ToolCallRow[] {
  return detail.timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call]));
}

// the transcript loads the run of each agent message once, and an ended run does not change, so the page keeps it.
const runs = new Map<string, Promise<RunDetail>>();

export function loadRun(runId: string): Promise<RunDetail> {
  let pending = runs.get(runId);
  if (!pending) {
    pending = api<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
    runs.set(runId, pending);
    // a failed load, and a run that still runs, are loaded again the next time.
    pending.then(
      (detail) => detail.run.status === 'running' && runs.delete(runId),
      () => runs.delete(runId),
    );
  }
  return pending;
}

// the element that scrolls the transcript. in the shell it is the main area, and outside it the window.
export function scrollParent(node: HTMLElement | null): HTMLElement {
  for (let at = node?.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return at;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}
