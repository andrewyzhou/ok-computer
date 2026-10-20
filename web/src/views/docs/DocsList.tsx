import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DOC_KINDS, type DocKind, type DocListItem, type DocsPage } from '../../../../src/dashboard/docs-types';
import { api, useStream } from '../../api';
import { plural, time } from '../../format';
import type { RouteProps } from '../../routes';
import { Badge, Button, EmptyState, FilterBar, Highlight, Page, SearchField, Segmented, Select, Skeleton, Table, type Column } from '../../ui';
import { docHref, docsApi, docsHref, kindLabel } from './shared';
import './list.css';

// the list of the docs at #/docs, with a kind filter and a search. the filters live in the query of the hash, so a
// link opens the list with its filters, and the back button brings them back.

// the page waits this long after the last key before it changes the hash, so a word gives one request.
const TYPE_DELAY_MS = 250;
// a burst of stream messages gives one reload, not one for each message.
const RELOAD_DELAY_MS = 300;
const PAGE_SIZE = 30;
// the server takes a q of at most 200 characters.
const MAX_QUERY = 200;
// the width where the table gives way to cards. it matches the sm breakpoint of styles.css.
const CARDS_BELOW = 760;

const TAINT_TITLE = 'The writer of this doc had read untrusted content, such as a web page or a mail, so its text can repeat outside text.';

type KindValue = DocKind | '';

const KIND_OPTIONS: Array<{ value: KindValue; label: string }> = [{ value: '', label: 'All' }, ...DOC_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) }))];

// a kind from the hash. a value that is not a kind is left out, so the list shows all kinds.
function kindOf(value: string | null): KindValue {
  return value !== null && (DOC_KINDS as readonly string[]).includes(value) ? (value as DocKind) : '';
}

// the hash changes in place while the owner types, so the back button skips the texts in between. the shell listens
// for hashchange, which replaceState does not send by itself.
function replaceHash(next: string): void {
  if (location.hash === next) return;
  history.replaceState(history.state, '', next);
  dispatchEvent(new Event('hashchange'));
}

function pushHash(next: string): void {
  if (location.hash !== next) location.hash = next;
}

// true on a screen narrower than width. it follows a resize, so the cards and the table swap in place.
function useNarrowerThan(width: number): boolean {
  const media = () => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(`(max-width: ${width - 0.02}px)`) : null);
  return useSyncExternalStore(
    (listener) => {
      const query = media();
      query?.addEventListener?.('change', listener);
      return () => query?.removeEventListener?.('change', listener);
    },
    () => media()?.matches ?? false,
    () => false,
  );
}

interface ListState {
  // the filters that the rows belong to.
  key: string;
  pages: DocsPage[];
  error?: string;
  // the key of a request that has not answered yet.
  loading: string | null;
  more: { busy: boolean; error?: string };
}

const EMPTY: ListState = { key: '', pages: [], loading: null, more: { busy: false } };

// the rows of the list. a new filter keeps the old rows on view until its answer comes, and only the answer of the
// newest request shows, so a slow answer to an old text never replaces a newer one. load more appends the next page,
// and a reload asks for as many rows as the list shows, so the rows that load more added stay.
function useDocs(q: string, kind: KindValue) {
  const key = JSON.stringify([q, kind]);
  const [state, setState] = useState<ListState>(EMPTY);
  const latest = useRef(0);
  const shown = useRef<ListState>(EMPTY);
  shown.current = state;

  const first = useCallback(
    (reload: boolean) => {
      const ticket = ++latest.current;
      const query = { ...(q ? { q } : {}), ...(kind ? { kind } : {}) };
      // a reload of the same filters loads as many pages as the list shows. a search has no paging.
      const old = shown.current;
      const want = reload && old.key === key && !q ? old.pages.reduce((sum, page) => sum + page.docs.length, 0) : 0;
      setState((now) => ({ ...now, loading: key, ...(now.key === key ? {} : { more: { busy: false } }) }));
      const load = async (): Promise<DocsPage[]> => {
        const pages = [await api<DocsPage>(docsApi({ ...query, limit: PAGE_SIZE }))];
        let rows = pages[0]!.docs.length;
        while (rows < want && pages.at(-1)!.nextCursor) {
          const next = await api<DocsPage>(docsApi({ ...query, cursor: pages.at(-1)!.nextCursor!, limit: PAGE_SIZE }));
          pages.push(next);
          rows += next.docs.length;
        }
        return pages;
      };
      load().then(
        (pages) => ticket === latest.current && setState({ key, pages, loading: null, more: { busy: false } }),
        (err: Error) => ticket === latest.current && setState({ key, pages: [], error: err.message, loading: null, more: { busy: false } }),
      );
    },
    [q, kind, key],
  );

  useEffect(() => first(false), [first]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useStream((message) => {
    // a run can write or change a doc, so the list loads again when a run ends.
    if (message.kind !== 'run' || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      first(true);
    }, RELOAD_DELAY_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const fresh = state.key === key;
  const last = fresh ? state.pages.at(-1) : undefined;
  const cursor = !q && last?.nextCursor ? last.nextCursor : null;
  const more =
    cursor === null
      ? null
      : () => {
          const ticket = latest.current;
          setState((now) => ({ ...now, more: { busy: true } }));
          api<DocsPage>(docsApi({ ...(kind ? { kind } : {}), cursor, limit: PAGE_SIZE })).then(
            (page) =>
              ticket === latest.current &&
              setState((now) => (now.key === key ? { ...now, pages: [...now.pages, page], more: { busy: false } } : now)),
            (err: Error) => ticket === latest.current && setState((now) => (now.key === key ? { ...now, more: { busy: false, error: err.message } } : now)),
          );
        };

  return {
    // the rows on view, which can belong to the filters before the ones in the hash while those load.
    rows: state.pages.flatMap((page) => page.docs),
    fresh,
    started: state.key !== '' || state.error !== undefined,
    loading: state.loading !== null,
    error: state.error,
    more,
    moreBusy: state.more.busy,
    moreError: state.more.error,
    retry: () => first(false),
  };
}

function TaintBadge({ doc }: { doc: DocListItem }) {
  if (!doc.tainted) return null;
  return (
    <Badge tone="warning" title={TAINT_TITLE}>
      outside text
    </Badge>
  );
}

function Snippet({ doc }: { doc: DocListItem }) {
  if (!doc.snippet) return null;
  return (
    <p className="docs-snippet">
      <Highlight text={doc.snippet} marks={doc.marks} />
    </p>
  );
}

const author = (doc: DocListItem) => (doc.author === 'owner' ? 'you' : 'agent');

const columns: Array<Column<DocListItem>> = [
  {
    key: 'title',
    header: 'Title',
    wrap: true,
    cell: (doc) => (
      <div className="docs-title-cell">
        <a className="docs-title" href={docHref(doc.id)}>
          {doc.title}
        </a>
        <Snippet doc={doc} />
      </div>
    ),
  },
  {
    key: 'kind',
    header: 'Kind',
    cell: (doc) => (
      <span className="docs-badges">
        <Badge>{kindLabel(doc.kind)}</Badge>
        <TaintBadge doc={doc} />
      </span>
    ),
  },
  { key: 'version', header: 'Version', align: 'end', cell: (doc) => `v${doc.version}` },
  { key: 'comments', header: 'Comments', align: 'end', cell: (doc) => (doc.comments ? doc.comments : '') },
  { key: 'author', header: 'Author', cell: author },
  {
    key: 'updated',
    header: 'Updated',
    cell: (doc) => (
      <time className="docs-nowrap" dateTime={doc.updatedAt}>
        {time(doc.updatedAt)}
      </time>
    ),
  },
];

// a phone shows each doc as a card. the title link covers the whole card, so a tap anywhere opens the doc.
function DocCards({ rows }: { rows: DocListItem[] }) {
  return (
    <ul className="docs-cards" aria-label="docs">
      {rows.map((doc) => (
        <li key={doc.id} className="docs-card">
          <a className="docs-card-title" href={docHref(doc.id)}>
            {doc.title}
          </a>
          <p className="docs-card-meta">
            <Badge>{kindLabel(doc.kind)}</Badge>
            <span>v{doc.version}</span>
            <time dateTime={doc.updatedAt}>{time(doc.updatedAt)}</time>
            <TaintBadge doc={doc} />
          </p>
          <Snippet doc={doc} />
        </li>
      ))}
    </ul>
  );
}

export function DocsListPage({ query }: RouteProps) {
  const urlText = (query.get('q') ?? '').slice(0, MAX_QUERY);
  const q = urlText.trim();
  const kind = kindOf(query.get('kind'));
  const narrow = useNarrowerThan(CARDS_BELOW);
  const list = useDocs(q, kind);

  // the text of the box runs ahead of the hash while the owner types. a new hash from outside, such as the back
  // button, puts its text in the box.
  const [text, setText] = useState(urlText);
  const committed = useRef(urlText);
  const typing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  useEffect(() => {
    if (urlText === committed.current) return;
    committed.current = urlText;
    clearTimeout(timer.current);
    typing.current = false;
    setText(urlText);
  }, [urlText]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // the first change of a burst of typing adds a history entry, and the next ones replace it, so the back button goes
  // to the filters before the search and not to each key.
  const commit = (value: string) => {
    committed.current = value;
    const next = docsHref({ q: value, ...(kindRef.current ? { kind: kindRef.current } : {}) });
    if (typing.current) replaceHash(next);
    else pushHash(next);
    typing.current = true;
  };
  const onType = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), TYPE_DELAY_MS);
  };
  const onKind = (value: string) => {
    clearTimeout(timer.current);
    typing.current = false;
    committed.current = text;
    pushHash(docsHref({ q: text, ...(kindOf(value) ? { kind: kindOf(value) as DocKind } : {}) }));
  };
  const clear = () => {
    clearTimeout(timer.current);
    typing.current = false;
    committed.current = '';
    setText('');
    pushHash(docsHref());
  };

  const filtered = Boolean(q || kind);
  const rows = list.rows;
  // the first run has no count, because its empty state says it all.
  const subtitle = !list.fresh || list.error || (!rows.length && !filtered) ? undefined : q ? 'Search results' : `${plural(rows.length, 'doc')}${list.more ? ' so far' : ''}`;

  const toolbar = (
    <FilterBar label="doc filters">
      <div className="docs-search">
        <SearchField label="Search docs" placeholder="Search docs" value={text} onChange={onType} maxLength={MAX_QUERY} />
      </div>
      {narrow ? (
        <Select label="kind" value={kind} options={KIND_OPTIONS.slice(1)} allLabel="All" onChange={onKind} />
      ) : (
        <Segmented label="kind" value={kind} options={KIND_OPTIONS} onChange={onKind} />
      )}
    </FilterBar>
  );

  let body;
  if (list.error && list.fresh) {
    body = (
      <div className="docs-error">
        <p className="error-box" role="alert">
          Could not load the docs: {list.error}
        </p>
        <div>
          <Button size="sm" icon="refresh" busy={list.loading} onClick={list.retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (!list.started || (!list.fresh && !rows.length)) {
    body = <Skeleton lines={6} label="Loading the docs…" />;
  } else if (!rows.length) {
    body = filtered ? (
      <EmptyState
        icon="search"
        title="No docs match"
        action={
          <Button size="sm" onClick={clear}>
            Clear filters
          </Button>
        }
      >
        {q ? `No doc has the words “${q}”${kind ? ` in ${kindLabel(kind)}` : ''}.` : `No doc is of the kind ${kindLabel(kind as DocKind)}.`}
      </EmptyState>
    ) : (
      <EmptyState icon="docs" title="No docs yet">
        When an answer is long, the agent writes a doc here and sends you the link in the chat.
      </EmptyState>
    );
  } else {
    body = (
      <div className={`docs-list${list.loading ? ' is-loading' : ''}`} aria-busy={list.loading || undefined}>
        {narrow ? (
          <DocCards rows={rows} />
        ) : (
          <Table label="docs" columns={columns} rows={rows} rowKey={(doc) => String(doc.id)} onSelect={(doc) => pushHash(docHref(doc.id))} />
        )}
        {list.more || list.moreError ? (
          <div className="docs-more">
            {list.more ? (
              <Button size="sm" busy={list.moreBusy} onClick={list.more}>
                Load more
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
    <Page title="Docs" subtitle={subtitle} toolbar={toolbar}>
      {body}
    </Page>
  );
}
