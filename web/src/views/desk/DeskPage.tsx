import { useEffect, useRef, useState } from 'react';
import type { DelegationStatus, DeskBoard } from '../../../../src/dashboard/desk-types';
import { useApi } from '../../api';
import type { RouteProps } from '../../routes';
import { Button, EmptyState, FilterBar, Page, SearchField, Select, Skeleton, Tabs, type Option } from '../../ui';
import { Board } from './Board';
import { NewDelegationPanel } from './DelegationForm';
import { DelegationPanel } from './Details';
import { MAX_DESK_Q, STATUSES, STATUS_LABEL, boardPath, deskQueryOf, refreshDesk, setDeskQuery } from './data';
import './desk.css';

// the desk: a board of the delegations with a column for each status, the filters by status and person, the details
// panel of the selected delegation and the create form. Board.tsx draws the columns, Details.tsx the details panel and
// DelegationForm.tsx the create and edit form.

// the search goes into the hash this long after the last key, so each key does not load the board.
const SEARCH_DELAY_MS = 300;

type StatusTab = DelegationStatus | 'all';

// the route refuses a filter with this kind of error. the page shows it next to the search, not as a load failure.
const FILTER_ERROR = /^give (q|person) /;

// the search field keeps its text while the owner types, and writes it to the hash after a pause. a change of the
// hash from elsewhere, for example the clear button, sets the text again. the text of the hash is cut to the limit of
// the route, like the filter of the board.
function DeskSearch({ query }: { query: URLSearchParams }) {
  const hashValue = deskQueryOf(query).q ?? '';
  const [value, setValue] = useState(hashValue);
  const latest = useRef(query);
  latest.current = query;
  useEffect(() => setValue(hashValue), [hashValue]);
  useEffect(() => {
    // the text is compared with the cut text of the hash, so opening a link with a long or a blank q writes nothing.
    if (value === (deskQueryOf(latest.current).q ?? '')) return;
    const timer = setTimeout(() => setDeskQuery(latest.current, { q: value.trim().slice(0, MAX_DESK_Q) || null }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return <SearchField label="Search the desk" placeholder="Search" value={value} onChange={setValue} maxLength={MAX_DESK_Q} />;
}

// the note under the filter bar for a search that the route refused, or for a search in a link that was cut to the
// limit. it takes a row of its own, so the controls of the bar stay on one line.
function SearchNote({ query, error }: { query: URLSearchParams; error?: string | undefined }) {
  const cut = (query.get('q') ?? '').trim().length > MAX_DESK_Q;
  const note = error ?? (cut ? `The search uses the first ${MAX_DESK_Q} characters.` : undefined);
  if (!note) return null;
  return (
    <p className={`desk-search-note${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>
      {note}
    </p>
  );
}

// the words of a filter error of the route, for the note under the search.
const filterErrorText = (error: string) =>
  error.startsWith('give q ') ? `Search with 1 to ${MAX_DESK_Q} characters.` : 'Pick a person from the list.';

export function DeskPage({ query }: RouteProps) {
  const filters = deskQueryOf(query);
  const board = useApi<DeskBoard>(boardPath(filters), refreshDesk);
  const filterError = board.error !== undefined && FILTER_ERROR.test(board.error) ? filterErrorText(board.error) : undefined;
  const rawId = query.get('id');
  const selectedId = rawId && /^[1-9]\d{0,15}$/.test(rawId) ? Number(rawId) : null;
  const creating = query.get('new') === '1';
  const filtered = Boolean(filters.status || filters.person || filters.q);
  const data = board.data;
  const totals = new Map(data?.columns.map((column) => [column.status, column.total]) ?? []);
  const sum = [...totals.values()].reduce((all, each) => all + each, 0);
  // the tabs count the whole desk, so a filter never hides the overview. an older server gives no counts, and then
  // the tabs count the rows of the filter.
  const counts = new Map<DelegationStatus, number>(data?.counts ? STATUSES.map((status) => [status, data.counts![status] ?? 0]) : totals);
  const everything = [...counts.values()].reduce((all, each) => all + each, 0);

  const openNew = () => setDeskQuery(query, { new: '1', id: null });
  const clearFilters = () => setDeskQuery(query, { status: null, person: null, q: null });

  const tabs: Array<{ id: StatusTab; label: string; count?: number }> = [
    { id: 'all', label: 'All', ...(data ? { count: everything } : {}) },
    ...STATUSES.map((status) => ({ id: status, label: STATUS_LABEL[status], ...(data ? { count: counts.get(status) ?? 0 } : {}) })),
  ];
  const people: Option[] = (data?.people ?? []).map((person) => ({ value: person.key, label: person.name ?? person.email ?? person.key }));
  // a person in the hash that the list does not have, for example one whose delegations all closed, still shows.
  if (filters.person && !people.some((each) => typeof each !== 'string' && each.value === filters.person)) people.push({ value: filters.person, label: filters.person });
  // with a status filter the board shows only that column.
  const shown = data && filters.status ? { ...data, columns: data.columns.filter((column) => column.status === filters.status) } : data;

  return (
    <Page
      title="Desk"
      subtitle="What ok computer is handling for you, and who it waits on."
      width="full"
      actions={
        <Button variant="primary" icon="plus" onClick={openNew}>
          New delegation
        </Button>
      }
      toolbar={
        <FilterBar label="desk filters">
          <Tabs label="status" items={tabs} value={filters.status ?? 'all'} onChange={(status) => setDeskQuery(query, { status: status === 'all' ? null : status })} />
          <Select label="Person" icon="people" value={filters.person ?? ''} options={people} allLabel="Everyone" onChange={(person) => setDeskQuery(query, { person: person || null })} />
          <DeskSearch query={query} />
          {filtered ? (
            <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
          <SearchNote query={query} error={filterError} />
        </FilterBar>
      }
    >
      {filterError !== undefined ? (
        <EmptyState
          icon="desk"
          title="The desk cannot use this filter."
          action={
            <Button icon="close" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : board.error !== undefined ? (
        <div className="error-box desk-error" role="alert">
          <p>Could not load the desk: {board.error}</p>
          <Button size="sm" onClick={board.reload}>
            Try again
          </Button>
        </div>
      ) : !shown ? (
        <Skeleton lines={6} />
      ) : sum === 0 && !filtered ? (
        <EmptyState
          icon="desk"
          title="Nothing on your desk yet."
          action={
            <Button variant="primary" icon="plus" onClick={openNew}>
              New delegation
            </Button>
          }
        >
          Ask in chat, for example "can you handle the lease renewal?", and it shows up here. You can also add one yourself.
        </EmptyState>
      ) : sum === 0 ? (
        <EmptyState
          icon="desk"
          title="No delegation matches these filters."
          action={
            <Button icon="close" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="desk-page">
          {shown.dueToday > 0 ? <p className="desk-due-today">{`${shown.dueToday} due today`}</p> : null}
          <Board board={shown} selectedId={selectedId} onSelect={(id) => setDeskQuery(query, { id: String(id), new: null })} />
        </div>
      )}
      {creating ? (
        <NewDelegationPanel
          {...(data?.timeZone ? { timeZone: data.timeZone } : {})}
          onDone={(delegation) => {
            setDeskQuery(query, { new: null, id: String(delegation.id) });
            board.reload();
          }}
          onCancel={() => setDeskQuery(query, { new: null })}
        />
      ) : selectedId !== null ? (
        <DelegationPanel
          id={selectedId}
          onClose={() => setDeskQuery(query, { id: null })}
          onChanged={board.reload}
          {...(data?.timeZone ? { timeZone: data.timeZone } : {})}
        />
      ) : null}
    </Page>
  );
}
