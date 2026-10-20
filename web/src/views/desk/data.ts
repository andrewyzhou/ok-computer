import type {
  Delegation,
  DelegationCreateRequest,
  DelegationEventKind,
  DelegationStatus,
  DelegationUpdateRequest,
  DeskQuery,
} from '../../../../src/dashboard/desk-types';
import { send } from '../../api';
import type { StreamMessage } from '../../../../src/dashboard/types';
import type { Tone } from '../../ui';

// the parts that the board and the details panel share: the api paths, the writes, the words and tones of a status,
// and the hash query. docs/API.md (T3) gives the routes.

export const DESK_PATH = 'desk';

export const STATUSES: readonly DelegationStatus[] = ['open', 'waiting', 'blocked', 'done', 'dropped'];

export const STATUS_LABEL: Record<DelegationStatus, string> = {
  open: 'Open',
  waiting: 'Waiting',
  blocked: 'Needs you',
  done: 'Done',
  dropped: 'Dropped',
};

export const STATUS_TONE: Record<DelegationStatus, Tone> = {
  open: 'info',
  waiting: 'warning',
  blocked: 'serious',
  done: 'good',
  dropped: 'muted',
};

// the words of each history row, before its text.
export const EVENT_LABEL: Record<DelegationEventKind, string> = {
  created: 'Created',
  updated: 'Changed',
  status: 'Status',
  waiting_on: 'Waiting on',
  link_added: 'Link added',
  link_removed: 'Link removed',
  note: 'Note',
  follow_up_checked: 'Checked for a reply',
  reply_seen: 'Reply came',
  nudge_drafted: 'Nudge drafted',
  follow_up_due: 'Follow-up due',
  follow_up_failed: 'Follow-up failed',
};

// the board loads again when a run ends, because an agent run or the follow-up job can change a delegation.
export const refreshDesk = (message: StreamMessage) => message.kind === 'run';

// a path with the query values that are set. an empty value is left out, so the server uses its default.
export function withQuery(path: string, values: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export const boardPath = (query: DeskQuery) => withQuery('/api/desk', { status: query.status, person: query.person, q: query.q });
export const detailPath = (id: number | string) => `/api/desk/delegations/${encodeURIComponent(String(id))}`;

export const createDelegation = (body: DelegationCreateRequest) => send<Delegation>('/api/desk/delegations', 'POST', body);
export const updateDelegation = (id: number, body: DelegationUpdateRequest) => send<Delegation>(detailPath(id), 'POST', body);

// the filters and the selection live in the query of the hash, so a link opens the board as it was.
export function setDeskQuery(query: URLSearchParams, changes: Record<string, string | null>): void {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  const search = next.toString();
  location.hash = `#/${DESK_PATH}${search ? `?${search}` : ''}`;
}

// the limits of the filters, the same as the route's: q has 1 to 200 characters and person 1 to 320.
export const MAX_DESK_Q = 200;
export const MAX_DESK_PERSON = 320;

// a filter value of the hash, trimmed and cut to its limit, or undefined when it is blank. a link or a hash typed by
// hand can hold any text, and the route answers 400 for a blank or a long value, so the board would show an error.
const filterOf = (value: string | null, max: number) => (value ?? '').trim().slice(0, max).trim() || undefined;

// the filters of the board from the query of the hash. an unknown status is left out, and so is a blank q or person.
export function deskQueryOf(query: URLSearchParams): DeskQuery {
  const status = query.get('status');
  const person = filterOf(query.get('person'), MAX_DESK_PERSON);
  const q = filterOf(query.get('q'), MAX_DESK_Q);
  return {
    ...(status && (STATUSES as readonly string[]).includes(status) ? { status: status as DelegationStatus } : {}),
    ...(person ? { person } : {}),
    ...(q ? { q } : {}),
  };
}

// the name of the person of a delegation, for a card.
export const personLabel = (delegation: Pick<Delegation, 'waitingOn'>) => delegation.waitingOn?.name ?? delegation.waitingOn?.email ?? null;
