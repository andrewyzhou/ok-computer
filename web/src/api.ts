import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { StreamMessage } from '../../src/dashboard/types';

// the server asks for the token only when DASHBOARD_TOKEN is set. the page then gets it once in its own url.
const token = new URLSearchParams(globalThis.location?.search ?? '').get('token');

export function apiUrl(path: string): string {
  if (!token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  // with DASHBOARD_TOKEN set, a browser without the session cookie signs in one time on the login page.
  if (response.status === 401 && !token) globalThis.location?.assign('/login');
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body as T;
}

export function send<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  return api<T>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

type Listener = (message: StreamMessage) => void;
const listeners = new Set<Listener>();

// the state of the shared stream, for the status bar. the browser connects again by itself, so an error first means
// connecting, and offline means that the browser gave up.
export type Connection = 'connecting' | 'live' | 'offline';
let connection: Connection = 'connecting';
const connectionListeners = new Set<() => void>();

function setConnection(next: Connection): void {
  if (next === connection) return;
  connection = next;
  for (const each of connectionListeners) each();
}

export interface SharedStream {
  // it opens the stream when it is not open, and does nothing when it is.
  ensure(): void;
}

// one event stream that the whole page shares. a browser allows only six connections to one host, and a stream that
// stays open after a reload can block the requests of the new page, so the stream closes on pagehide. the browser can
// then keep the page in its back and forward cache, and when the page comes back from it, the stream opens again for
// the parts that still listen.
export function sharedStream(options: {
  path: string;
  setConnection: (next: Connection) => void;
  hasListeners: () => boolean;
  onMessage: (event: MessageEvent) => void;
}): SharedStream {
  let source: EventSource | undefined;
  let hooked = false;
  const ensure = (): void => {
    if (source || typeof EventSource === 'undefined') return;
    if (!hooked && typeof addEventListener === 'function') {
      hooked = true;
      addEventListener('pagehide', () => {
        source?.close();
        source = undefined;
        options.setConnection('connecting');
      });
      addEventListener('pageshow', (event) => {
        if ((event as PageTransitionEvent).persisted && options.hasListeners()) ensure();
      });
    }
    const opened = new EventSource(apiUrl(options.path));
    source = opened;
    opened.onopen = () => options.setConnection('live');
    // the browser connects again by itself after an error, so an error first means connecting. a closed stream does
    // not come back.
    opened.onerror = () => options.setConnection(opened.readyState === 2 ? 'offline' : 'connecting');
    opened.onmessage = options.onMessage;
  };
  return { ensure };
}

const stream = sharedStream({
  path: '/api/stream',
  setConnection,
  hasListeners: () => listeners.size > 0,
  onMessage: (event) => {
    const message = JSON.parse(String(event.data)) as StreamMessage;
    for (const each of listeners) each(message);
  },
});

// all pages share one event stream.
export function subscribe(listener: Listener): () => void {
  stream.ensure();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useConnection(): Connection {
  useEffect(() => subscribe(() => {}), []);
  return useSyncExternalStore(
    (listener) => {
      connectionListeners.add(listener);
      return () => void connectionListeners.delete(listener);
    },
    () => connection,
    () => connection,
  );
}

export function useStream(listener: Listener): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribe((message) => latest.current(message)), []);
}

export interface Loaded<T> {
  data?: T;
  error?: string;
  reload(): void;
}

// a burst of stream messages gives one reload, not one for each message.
const RELOAD_DELAY_MS = 300;

export function useApi<T>(path: string | null, refreshOn?: (message: StreamMessage) => boolean): Loaded<T> {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path });
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!path) return;
    let current = true;
    api<T>(path).then(
      (data) => current && setState({ path, data }),
      (err: Error) => current && setState({ path, error: err.message }),
    );
    return () => {
      current = false;
    };
  }, [path, version]);

  useStream((message) => {
    if (!refreshOn?.(message) || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setVersion((v) => v + 1);
    }, RELOAD_DELAY_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  // the data of an old path stays out of view while the new path loads.
  const fresh = state.path === path;
  return {
    ...(fresh && state.data !== undefined ? { data: state.data } : {}),
    ...(fresh && state.error !== undefined ? { error: state.error } : {}),
    reload: () => setVersion((v) => v + 1),
  };
}
