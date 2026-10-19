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
let source: EventSource | undefined;

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

// all pages share one event stream. the browser connects again by itself after an error.
export function subscribe(listener: Listener): () => void {
  if (!source && typeof EventSource !== 'undefined') {
    source = new EventSource(apiUrl('/api/stream'));
    // a browser allows only six connections to one host. a stream that stays open after a reload can block the
    // requests of the new page.
    addEventListener('pagehide', () => source?.close());
    const opened = source;
    opened.onopen = () => setConnection('live');
    opened.onerror = () => setConnection(opened.readyState === 2 ? 'offline' : 'connecting');
    source.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as StreamMessage;
      for (const each of listeners) each(message);
    };
  }
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
