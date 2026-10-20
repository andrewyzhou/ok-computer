import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  PeoplePage as PeopleList,
  PeopleAccountStatus,
  PeopleStatus,
  PersonContactRole,
  PersonMeetingView,
  PersonNoteKind,
  PersonNoteView,
  PersonProfile,
  PersonSort,
  PersonSummary,
} from '../../../../src/dashboard/people-types';
import type { StreamMessage } from '../../../../src/dashboard/types';
import { api, send, useApi } from '../../api';
import { plural } from '../../format';
import type { RouteProps } from '../../routes';
import { useDevMode } from '../../shell/prefs';
import { Badge, Button, ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, NotFound, Page, SearchField, Section, Segmented, Skeleton, Table, isNotFound, type Column } from '../../ui';
import { ago, day, dayTime } from './when';
import './people.css';

// the people list and the profile of params.id in the details panel. both hashes give this one page, so opening a
// profile keeps the list, its search and its scroll.

// the page waits this long after the last key before it changes the hash, so a word gives one request.
const TYPE_DELAY_MS = 250;
const PAGE_SIZE = 50;
// the first run polls the status at this pace, because the backfill sends nothing on the stream.
const FIRST_RUN_POLL_MS = 5000;
const MAX_QUERY = 200;
const MAX_NOTE = 2000;

const SORTS: Array<{ value: PersonSort; label: string }> = [
  { value: 'recent', label: 'Recent' },
  { value: 'frequent', label: 'Frequent' },
  { value: 'name', label: 'Name' },
];

const KINDS: Array<{ value: PersonNoteKind; label: string }> = [
  { value: 'note', label: 'Note' },
  { value: 'preference', label: 'Preference' },
];

const ROLE: Record<PersonContactRole, string> = { from: 'sender', to: 'recipient', cc: 'copied', organizer: 'organizer', attendee: 'guest' };

// a run of the agent can add a person or a note, so the page loads again when a run ends.
const refreshPeople = (message: StreamMessage) => message.kind === 'run';

const sortOf = (value: string | null): PersonSort => SORTS.find((each) => each.value === value)?.value ?? 'recent';

// the hash of the list or of a profile with the search and the sort of the list. the default sort is left out.
function peopleHash(id: string | null, q: string, sort: PersonSort): string {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (sort !== 'recent') query.set('sort', sort);
  const search = query.toString();
  return `#/people${id ? `/${encodeURIComponent(id)}` : ''}${search ? `?${search}` : ''}`;
}

// the hash changes in place while the owner types, so the back button skips the texts in between. the shell listens
// for hashchange, which replaceState does not send by itself.
function replaceHash(next: string): void {
  if (location.hash === next) return;
  history.replaceState(history.state, '', next);
  dispatchEvent(new Event('hashchange'));
}

function listPath(q: string, sort: PersonSort, cursor?: string): string {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  query.set('sort', sort);
  query.set('limit', String(PAGE_SIZE));
  if (cursor) query.set('cursor', cursor);
  return `/api/people?${query.toString()}`;
}

// an answer without a people list is a broken answer, and the page says so instead of failing.
function checkPage(page: PeopleList): PeopleList {
  if (!Array.isArray(page?.people)) throw new Error('the server sent a people list in a shape that this page does not know.');
  return page;
}

interface Paged {
  people: PersonSummary[];
  total?: number;
  error?: string;
  loading: boolean;
  more: (() => void) | null;
  loadingMore: boolean;
  moreError?: string;
  reload(): void;
}

// the list with its show more button. the later pages belong to the first page that they follow, so a new search or
// sort drops them and the list starts again.
function usePeople(q: string, sort: PersonSort): Paged {
  const path = listPath(q, sort);
  const first = useApi<PeopleList>(path, refreshPeople);
  const [later, setLater] = useState<{ of?: PeopleList; pages: PeopleList[]; busy: boolean; error?: string }>({ pages: [], busy: false });
  let checked: PeopleList | undefined;
  let shapeError: string | undefined;
  try {
    checked = first.data === undefined ? undefined : checkPage(first.data);
  } catch (err) {
    shapeError = (err as Error).message;
  }
  const current = later.of !== undefined && later.of === first.data ? later : { pages: [] as PeopleList[], busy: false, error: undefined };
  const pages = checked ? [checked, ...current.pages] : [];
  const next = pages.at(-1)?.next ?? null;
  const more = () => {
    if (next === null || first.data === undefined) return;
    const of = first.data;
    setLater({ of, pages: current.pages, busy: true });
    api<PeopleList>(listPath(q, sort, next))
      .then(checkPage)
      .then(
        (page) => setLater((old) => (old.of === of ? { of, pages: [...old.pages, page], busy: false } : old)),
        (err: Error) => setLater((old) => (old.of === of ? { ...old, busy: false, error: err.message } : old)),
      );
  };
  const error = first.error ?? shapeError;
  return {
    people: pages.flatMap((page) => page.people),
    ...(checked ? { total: checked.total } : {}),
    ...(error !== undefined ? { error } : {}),
    loading: first.data === undefined && error === undefined,
    more: next === null ? null : more,
    loadingMore: current.busy,
    ...(current.error ? { moreError: current.error } : {}),
    reload: first.reload,
  };
}

function BackfillLine({ account }: { account: PeopleAccountStatus }) {
  const read = `${plural(account.backfillMessages, 'message')} and ${plural(account.backfillEvents, 'event')}`;
  const text: Record<PeopleAccountStatus['backfill'], string> = {
    pending: 'waiting to start',
    running: `reading, ${read} so far`,
    done: `done, ${read}`,
    failed: `failed${account.error ? `: ${account.error}` : ''}`,
  };
  return (
    <li>
      <span className="people-account">{account.account}</span>
      <span className={account.backfill === 'failed' ? 'error-text' : 'muted'}>{text[account.backfill]}</span>
    </li>
  );
}

function NameCell({ person }: { person: PersonSummary }) {
  return (
    <div className="people-name">
      <span className="people-name-main">{person.displayName}</span>
      {person.name ? <span className="muted small people-name-email">{person.primaryEmail}</span> : null}
      {/* a person without a name has one line, so a phone shows the organization there in place of its column. */}
      {!person.name && person.organization ? <span className="muted small people-narrow">{person.organization}</span> : null}
    </div>
  );
}

const columns: Array<Column<PersonSummary>> = [
  { key: 'name', header: 'Name', wrap: true, cell: (row) => <NameCell person={row} /> },
  { key: 'organization', header: 'Organization', hideBelow: 'sm', cell: (row) => row.organization ?? <span className="muted">-</span> },
  {
    key: 'last',
    header: 'Last contact',
    cell: (row) =>
      row.lastContactAt ? (
        <time className="people-nowrap" dateTime={row.lastContactAt} title={dayTime(row.lastContactAt)}>
          {ago(row.lastContactAt)}
        </time>
      ) : (
        <span className="muted people-nowrap">none yet</span>
      ),
  },
  { key: 'mail', header: 'Mail', align: 'end', hideBelow: 'sm', cell: (row) => row.mailCount },
  { key: 'meetings', header: 'Meetings', align: 'end', hideBelow: 'sm', cell: (row) => row.meetingCount },
  {
    key: 'next',
    header: 'Next meeting',
    hideBelow: 'md',
    cell: (row) => (row.nextMeetingAt ? <span className="people-nowrap">{dayTime(row.nextMeetingAt)}</span> : <span className="muted">-</span>),
  },
];

function Meetings({ meetings, empty }: { meetings: PersonMeetingView[]; empty: string }) {
  if (!meetings.length) return <p className="muted people-none">{empty}</p>;
  return (
    <ul className="people-list">
      {meetings.map((meeting) => (
        <li key={`${meeting.account}:${meeting.eventId}`}>
          <span className="people-item-title">{meeting.title}</span>
          <span className="muted small">
            <time dateTime={meeting.startAt}>{dayTime(meeting.startAt)}</time> · {ROLE[meeting.role]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Notes({ notes, empty, devMode }: { notes: PersonNoteView[]; empty: string; devMode: boolean }) {
  if (!notes.length) return <p className="muted people-none">{empty}</p>;
  return (
    <ul className="people-list">
      {notes.map((note) => (
        <li key={note.id}>
          <span className="people-note-text">{note.text}</span>
          <span className="muted small">
            <span className="people-author">
              {note.author === 'owner' ? (
                'You'
              ) : devMode && note.runId ? (
                <a href={`#/runs/${encodeURIComponent(note.runId)}`} title={`run ${note.runId}`}>
                  Agent
                </a>
              ) : (
                'Agent'
              )}
            </span>{' '}
            · <time dateTime={note.createdAt}>{day(note.createdAt)}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}

function NoteForm({ id, onSaved }: { id: number; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PersonNoteKind>('note');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const blank = !text.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blank || busy) return;
    setBusy(true);
    setError(undefined);
    send<PersonNoteView>(`/api/people/${id}/notes`, 'POST', { kind, text: text.trim() }).then(
      () => {
        setBusy(false);
        setText('');
        onSaved();
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  return (
    <form className="people-form" onSubmit={submit} aria-label="add a note">
      <label className="people-field">
        <span>Add a note</span>
        <textarea rows={3} maxLength={MAX_NOTE} value={text} onChange={(event) => setText(event.target.value)} placeholder="for example prefers calls after 14:00" />
      </label>
      <div className="people-form-row">
        <Segmented label="Kind" value={kind} options={KINDS} onChange={setKind} />
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={blank}>
          Save
        </Button>
      </div>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ProfileBody({ profile, devMode, onSaved }: { profile: PersonProfile; devMode: boolean; onSaved: () => void }) {
  const others = profile.names.filter((each) => each.name !== profile.name);
  return (
    <div className="people-profile">
      <Facts
        layout="stacked"
        items={[
          {
            label: 'Organization',
            value: profile.organization ? (
              <span>
                {profile.organization} <span className="muted">{profile.organizationDomain}</span>
              </span>
            ) : (
              <span className="muted">none (a personal address)</span>
            ),
          },
          {
            label: profile.emailDetails.length === 1 ? 'Email' : 'Emails',
            value: (
              <ul className="people-emails">
                {profile.emailDetails.map((each) => (
                  <li key={each.email}>
                    <span className="people-email">{each.email}</span>
                    {each.isPrimary ? <Badge tone="muted">primary</Badge> : null}
                  </li>
                ))}
              </ul>
            ),
          },
          others.length
            ? {
                label: 'Other names',
                value: (
                  <ul className="people-emails">
                    {others.map((each) => (
                      <li key={each.name}>
                        {each.name} <span className="muted small">({plural(each.count, 'time')})</span>
                      </li>
                    ))}
                  </ul>
                ),
              }
            : null,
          { label: 'First contact', value: profile.firstContactAt ? dayTime(profile.firstContactAt) : <span className="muted">none yet</span> },
          { label: 'Last contact', value: profile.lastContactAt ? dayTime(profile.lastContactAt) : <span className="muted">none yet</span> },
          { label: 'Contact', value: `${plural(profile.mailCount, 'mail')}, ${plural(profile.meetingCount, 'meeting')}` },
        ]}
      />
      <Section title="Upcoming meetings">
        <Meetings meetings={profile.upcoming} empty="No meeting planned." />
      </Section>
      {profile.recentMeetings.length ? (
        <Section title="Recent meetings">
          <Meetings meetings={profile.recentMeetings} empty="" />
        </Section>
      ) : null}
      <Section title="Open threads">
        {profile.openThreads.length ? (
          <ul className="people-list">
            {profile.openThreads.map((thread) => (
              <li key={`${thread.account}:${thread.threadId}`}>
                <span className="people-item-title">{thread.subject}</span>
                <span className="muted small">
                  <time dateTime={thread.lastAt}>{ago(thread.lastAt)}</time> · {thread.account} · {plural(thread.messages, 'message')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted people-none">No thread waits on you.</p>
        )}
      </Section>
      <Section title="Preferences">
        <Notes notes={profile.preferences} empty="No preference yet." devMode={devMode} />
      </Section>
      <Section title="Notes">
        <Notes notes={profile.notes} empty="No note yet." devMode={devMode} />
      </Section>
      {profile.delegations.length ? (
        <Section title="Delegations">
          <ul className="people-list">
            {profile.delegations.map((each) => (
              <li key={each.id}>
                <span className="people-item-title">{each.title}</span>
                <span className="muted small">
                  {each.status.replace(/_/g, ' ')}
                  {each.dueAt ? ` · due ${day(each.dueAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <NoteForm key={profile.id} id={profile.id} onSaved={onSaved} />
    </div>
  );
}

function Profile({ id, onClose }: { id: string; onClose: () => void }) {
  const devMode = useDevMode();
  const valid = /^\d+$/.test(id);
  const profile = useApi<PersonProfile>(valid ? `/api/people/${id}` : null, refreshPeople);
  const missing = !valid || (profile.error !== undefined && isNotFound(profile.error));
  const title = profile.data?.displayName ?? (missing ? 'Person' : profile.error ? 'Person' : 'Loading…');
  return (
    <DetailsPanel title={title} openKey={id} onClose={onClose}>
      {missing ? (
        <NotFound icon="people" what="person">
          <a href="#/people">Back to People</a>
        </NotFound>
      ) : profile.error ? (
        <p className="error-box" role="alert">
          Could not load this person: {profile.error}
        </p>
      ) : !profile.data ? (
        <Skeleton lines={6} />
      ) : (
        <ProfileBody profile={profile.data} devMode={devMode} onSaved={profile.reload} />
      )}
    </DetailsPanel>
  );
}

export function PeoplePage({ params, query }: RouteProps) {
  const urlText = (query.get('q') ?? '').slice(0, MAX_QUERY);
  const q = urlText.trim();
  const sort = sortOf(query.get('sort'));
  const id = params.id ?? null;

  const [text, setText] = useState(urlText);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // a new hash from outside, for example the back button, gives the field its text.
  useEffect(() => {
    setText((old) => (old.trim() === q ? old : urlText));
  }, [urlText]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const list = usePeople(q, sort);
  const status = useApi<PeopleStatus>('/api/people/status', refreshPeople);
  const firstRun =
    status.data?.configured === true && status.data.people === 0 && status.data.accounts.some((each) => each.backfill === 'pending' || each.backfill === 'running');
  const reloadList = list.reload;
  const reloadStatus = status.reload;
  useEffect(() => {
    if (!firstRun) return;
    const poll = setInterval(() => {
      reloadStatus();
      reloadList();
    }, FIRST_RUN_POLL_MS);
    return () => clearInterval(poll);
  }, [firstRun]);

  const commit = (value: string) => {
    clearTimeout(timer.current);
    replaceHash(peopleHash(id, value.trim().slice(0, MAX_QUERY), sort));
  };
  const onType = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), TYPE_DELAY_MS);
  };
  const clearSearch = () => {
    setText('');
    commit('');
  };
  const setSort = (value: PersonSort) => {
    clearTimeout(timer.current);
    location.hash = peopleHash(id, text.trim().slice(0, MAX_QUERY), value);
  };
  const open = (person: PersonSummary) => {
    location.hash = peopleHash(String(person.id), q, sort);
  };
  const close = () => {
    location.hash = peopleHash(null, q, sort);
  };

  // with no google account or before the first read there is nothing to search or sort, so the page leaves the bar out.
  const noGoogle = status.data?.configured === false;
  const waiting = firstRun && !q && !list.error && !list.loading && !list.people.length;
  let body;
  if (noGoogle) {
    body = (
      <EmptyState
        icon="google"
        title="Connect Google to fill People"
        action={
          <ButtonLink href="#/google" variant="primary" icon="google">
            Set up Google
          </ButtonLink>
        }
      >
        People are built from the headers of your mail and the guests of your meetings. No mail text is stored.
      </EmptyState>
    );
  } else if (list.error) {
    body = (
      <p className="error-box" role="alert">
        Could not load people: {list.error}
      </p>
    );
  } else if (list.loading) {
    body = <Skeleton lines={6} label="Loading people…" />;
  } else if (!list.people.length && q) {
    body = (
      <EmptyState
        icon="search"
        title={`No one matches “${q}”.`}
        action={
          <Button size="sm" onClick={clearSearch}>
            Clear search
          </Button>
        }
      >
        The search looks at names, emails and organizations.
      </EmptyState>
    );
  } else if (waiting) {
    body = (
      <EmptyState icon="people" title="Reading your recent mail and calendar">
        <p>People fill in as the first read goes through the headers of each account.</p>
        <ul className="people-backfill" aria-label="backfill progress">
          {status.data!.accounts.map((account) => (
            <BackfillLine key={account.account} account={account} />
          ))}
        </ul>
      </EmptyState>
    );
  } else if (!list.people.length) {
    body = (
      <EmptyState icon="people" title="No people yet.">
        People show up here after the next mail or calendar poll.
      </EmptyState>
    );
  } else {
    body = (
      <div className="people-table">
        <Table label="people" columns={columns} rows={list.people} rowKey={(row) => String(row.id)} selected={id} onSelect={open} />
        {list.more || list.moreError ? (
          <div className="people-more">
            {list.more ? (
              <Button size="sm" busy={list.loadingMore} onClick={list.more}>
                Show more
              </Button>
            ) : null}
            {list.moreError ? (
              <span role="alert" className="error-text">
                Could not load more: {list.moreError}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Page
      title="People"
      // the profile has no crumb of its own, because its list is the same page and the panel names the person.
      crumbs={[]}
      subtitle={list.total !== undefined && !noGoogle && !waiting ? plural(list.total, 'person', 'people') : undefined}
      toolbar={
        noGoogle || waiting ? undefined : (
          <FilterBar label="people filters" end={<Segmented label="Sort" value={sort} options={SORTS} onChange={setSort} />}>
            <div className="people-search">
              <SearchField
                label="Search people"
                placeholder="Name, email or organization"
                value={text}
                onChange={onType}
                onKeyDown={(event) => event.key === 'Enter' && commit(text)}
                maxLength={MAX_QUERY}
              />
            </div>
          </FilterBar>
        )
      }
    >
      {body}
      {id ? (
        <Profile id={id} onClose={close} />
      ) : (
        <DetailsPanel title="People">
          <p className="muted">Select a person to see their emails, meetings, open threads and notes.</p>
        </DetailsPanel>
      )}
    </Page>
  );
}
