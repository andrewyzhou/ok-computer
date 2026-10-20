import { useEffect, useRef, useState } from 'react';
import type { DelegationStatus, DeskBoard } from '../../../../src/dashboard/desk-types';
import { useApi } from '../../api';
import type { RouteProps } from '../../routes';
import { Button, EmptyState, FilterBar, Page, SearchField, Select, Skeleton, Tabs, type Option } from '../../ui';
import { Board } from './Board';
import { NewDelegationPanel } from './DelegationForm';
import { DelegationPanel } from './Details';
import { STATUSES, STATUS_LABEL, boardPath, deskQueryOf, refreshDesk, setDeskQuery } from './data';
import './desk.css';

// the desk: a board of the delegations with a column for each status, the filters by status and person, the details
// panel of the selected delegation and the create form. Board.tsx draws the columns, Details.tsx the details panel and
// DelegationForm.tsx the create and edit form.

// the search goes into the hash this long after the last key, so each key does not load the board.
const SEARCH_DELAY_MS = 300;

type StatusTab = DelegationStatus | 'all';

// the search field keeps its text while the owner types, and writes it to the hash after a pause. a change of the
// hash from elsewhere, for example the clear button, sets the text again.
function DeskSearch({ query }: { query: URLSearchParams }) {
  const hashValue = query.get('q') ?? '';
  const [value, setValue] = useState(hashValue);
  const latest = useRef(query);
  latest.current = query;
  useEffect(() => setValue(hashValue), [hashValue]);
  useEffect(() => {
    if (value === (latest.current.get('q') ?? '')) return;
    const timer = setTimeout(() => setDeskQuery(latest.current, { q: value.trim() || null }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return <SearchField label="Search the desk" placeholder="Search" value={value} onChange={setValue} maxLength={200} />;
}

export function DeskPage({ query }: RouteProps) {
  const filters = deskQueryOf(query);
  const board = useApi<DeskBoard>(boardPath(filters), refreshDesk);
  const rawId = query.get('id');
  const selectedId = rawId && /^[1-9]\d{0,15}$/.test(rawId) ? Number(rawId) : null;
  const creating = query.get('new') === '1';
  const filtered = Boolean(filters.status || filters.person || filters.q);
  const data = board.data;
  const totals = new Map(data?.columns.map((column) => [column.status, column.total]) ?? []);
  const sum = [...totals.values()].reduce((all, each) => all + each, 0);

  const openNew = () => setDeskQuery(query, { new: '1', id: null });
  const clearFilters = () => setDeskQuery(query, { status: null, person: null, q: null });

  const tabs: Array<{ id: StatusTab; label: string; count?: number }> = [
    { id: 'all', label: 'All', ...(data ? { count: sum } : {}) },
    ...STATUSES.map((status) => ({ id: status, label: STATUS_LABEL[status], ...(data ? { count: totals.get(status) ?? 0 } : {}) })),
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
        </FilterBar>
      }
    >
      {board.error !== undefined ? (
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
          onDone={(delegation) => {
            setDeskQuery(query, { new: null, id: String(delegation.id) });
            board.reload();
          }}
          onCancel={() => setDeskQuery(query, { new: null })}
        />
      ) : selectedId !== null ? (
        <DelegationPanel id={selectedId} onClose={() => setDeskQuery(query, { id: null })} onChanged={board.reload} />
      ) : null}
    </Page>
  );
}
