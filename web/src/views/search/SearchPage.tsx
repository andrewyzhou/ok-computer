import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchGroup, SearchHit, SearchResults, SearchScope } from '../../../../src/dashboard/types';
import { api } from '../../api';
import { time } from '../../format';
import { Icon } from '../../icons';
import type { RouteProps } from '../../routes';
import { Button, ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, Highlight, IconButton, KeyHint, Page, SearchField, Section, Skeleton, Tabs, type TabItem } from '../../ui';
import { MAX_QUERY, SCOPES, scopeOf, searchHref, type ScopeDef } from './scopes';
import './search.css';

// the page waits this long after the last key before it changes the hash, so a word gives one request.
const TYPE_DELAY_MS = 250;

type TabId = 'all' | SearchScope;

interface Answer {
  key: string;
  data?: SearchResults;
  error?: string;
}

// the hash changes in place while the owner types, so the back button skips the texts in between. the shell listens
// for hashchange, which replaceState does not send by itself.
function replaceHash(href: string): void {
  const next = `#/${href}`;
  if (location.hash === next) return;
  history.replaceState(history.state, '', next);
  dispatchEvent(new Event('hashchange'));
}

function requestPath(q: string, scope: ScopeDef | undefined): string {
  return `/api/search?q=${encodeURIComponent(q)}${scope ? `&scope=${scope.id}` : ''}`;
}

const hitKey = (hit: SearchHit) => `${hit.scope}:${hit.id}`;

// the count of a tab. a scope with more hits than the limit shows a plus, because the server does not count them.
function countText(group: SearchGroup): string {
  return group.more ? `${group.hits.length}+` : String(group.hits.length);
}

function HitMeta({ hit }: { hit: SearchHit }) {
  const words = [
    hit.at ? (
      <time key="at" dateTime={hit.at}>
        {time(hit.at)}
      </time>
    ) : null,
    hit.sessionKey ? <span key="session">session {hit.sessionKey}</span> : null,
    hit.runId ? <span key="run">run {hit.runId}</span> : null,
  ].filter(Boolean);
  if (!words.length) return null;
  return <p className="search-hit-meta">{words}</p>;
}

function HitList({ group, scope, onSelect, selected }: { group: SearchGroup; scope: ScopeDef; onSelect: (hit: SearchHit) => void; selected: string | null }) {
  return (
    <ul className="search-hits" aria-label={scope.label}>
      {group.hits.map((hit) => (
        <li key={hit.id} className={selected === hitKey(hit) ? 'search-hit is-on' : 'search-hit'}>
          <Icon name={scope.icon} size={16} className="search-hit-icon" />
          <div className="search-hit-main">
            <a className="search-hit-title" href={`#/${hit.href}`}>
              {hit.title || hit.id}
            </a>
            {hit.snippet ? (
              <p className="search-hit-snippet">
                <Highlight text={hit.snippet} marks={hit.marks} />
              </p>
            ) : null}
            <HitMeta hit={hit} />
          </div>
          <IconButton icon="panel" size="sm" label={`Details of ${hit.title || hit.id}`} className="search-hit-details" onClick={() => onSelect(hit)} />
        </li>
      ))}
    </ul>
  );
}

function HitFacts({ hit }: { hit: SearchHit }) {
  const scope = scopeOf(hit.scope);
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'Scope', value: scope?.label ?? hit.scope },
          { label: 'Id', value: <code className="search-id">{hit.id}</code> },
          hit.at ? { label: 'Time', value: time(hit.at) } : null,
          hit.sessionKey ? { label: 'Session', value: <a href={`#/sessions/${encodeURIComponent(hit.sessionKey)}`}>{hit.sessionKey}</a> } : null,
          hit.runId ? { label: 'Run', value: <a href={`#/runs/${encodeURIComponent(hit.runId)}`}>{hit.runId}</a> } : null,
          hit.chatKey ? { label: 'Chat', value: <a href={`#/chats/${encodeURIComponent(hit.chatKey)}`}>{hit.chatKey}</a> } : null,
        ]}
      />
      {hit.snippet ? (
        <p className="search-details-snippet">
          <Highlight text={hit.snippet} marks={hit.marks} />
        </p>
      ) : null}
      <div>
        <ButtonLink href={`#/${hit.href}`} size="sm" variant="primary" icon={scope?.icon ?? 'search'}>
          Open
        </ButtonLink>
      </div>
    </>
  );
}

export function SearchPage({ query }: RouteProps) {
  const urlText = (query.get('q') ?? '').slice(0, MAX_QUERY);
  const q = urlText.trim();
  const scope = scopeOf(query.get('scope'));
  const tab: TabId = scope?.id ?? 'all';

  const [text, setText] = useState(urlText);
  const [answer, setAnswer] = useState<Answer>({ key: '' });
  // the counts of the tabs come from the last answer for every scope, so a tab of one scope keeps them.
  const [counts, setCounts] = useState<{ q: string; groups: SearchGroup[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // a counter, so a second choice of the same result opens the drawer of a narrow screen again.
  const [opened, setOpened] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const results = useRef<HTMLDivElement>(null);

  // a new hash from outside, for example the command menu, gives the field its text.
  useEffect(() => {
    setText((old) => (old.slice(0, MAX_QUERY) === urlText ? old : urlText));
  }, [urlText]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const key = `${q}\n${tab}`;
  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    api<SearchResults>(requestPath(q, scope), { signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        setAnswer({ key, data });
        if (!scope) setCounts({ q, groups: data.groups });
      },
      (err: Error) => !controller.signal.aborted && setAnswer({ key, error: err.message }),
    );
    // a newer text or tab aborts the older request, so a slow answer never replaces a newer one.
    return () => controller.abort();
  }, [key]);

  const commit = (value: string) => {
    clearTimeout(timer.current);
    replaceHash(searchHref(value.slice(0, MAX_QUERY), scope?.id));
  };
  const onType = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), TYPE_DELAY_MS);
  };
  const showScope = (id: TabId) => {
    clearTimeout(timer.current);
    location.hash = `#/${searchHref(text.slice(0, MAX_QUERY), id === 'all' ? undefined : id)}`;
  };

  const links = () => [...(results.current?.querySelectorAll<HTMLAnchorElement>('a.search-hit-title') ?? [])];
  const onFieldKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(text);
    } else if (event.key === 'ArrowDown') {
      const first = links()[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  };
  const onResultsKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = links();
    const at = all.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    event.preventDefault();
    const next = at + (event.key === 'ArrowDown' ? 1 : -1);
    all[Math.max(0, Math.min(next, all.length - 1))]?.focus();
  };

  const fresh = answer.key === key;
  const data = fresh ? answer.data : undefined;
  const error = fresh ? answer.error : undefined;
  const shown = data?.groups.filter((group) => group.hits.length > 0 && scopeOf(group.scope)) ?? [];
  const known = counts?.q === q ? counts.groups : undefined;

  const tabs: Array<TabItem<TabId>> = [
    { id: 'all', label: 'All' },
    ...SCOPES.map((each) => {
      const group = known?.find((g) => g.scope === each.id);
      // the tabs take a number as their count, so a count with a plus goes in the label.
      if (group?.more) return { id: each.id, label: `${each.label} ${countText(group)}` };
      return { id: each.id, label: each.label, ...(group ? { count: group.hits.length } : {}) };
    }),
  ];

  const hits = shown.flatMap((group) => group.hits);
  const selectedHit = hits.find((hit) => hitKey(hit) === selected);
  const select = (hit: SearchHit) => {
    setSelected(hitKey(hit));
    setOpened((count) => (count ?? 0) + 1);
  };

  let body;
  if (!q) {
    body = (
      <EmptyState icon="search" title="Search chats, runs, tool calls, automations, memory and approvals.">
        Press <KeyHint keys={['mod', 'K']} label="command K" /> on any page to search from the command menu.
      </EmptyState>
    );
  } else if (error) {
    body = (
      <p className="error-box" role="alert">
        {error}
      </p>
    );
  } else if (!data) {
    body = <Skeleton lines={6} label="Searching…" />;
  } else if (!shown.length) {
    body = <EmptyState icon="search" title={`Nothing matches “${q}”.`} />;
  } else {
    body = (
      <div className="search-results" ref={results} onKeyDown={onResultsKey}>
        {shown.map((group) => {
          const each = scopeOf(group.scope)!;
          return (
            <Section
              key={group.scope}
              title={
                <span className="search-section-title">
                  {each.label} <span className="search-section-count">{countText(group)}</span>
                </span>
              }
              actions={
                group.more && !scope ? (
                  <Button variant="ghost" size="sm" onClick={() => showScope(each.id)}>
                    Show all {each.label.toLowerCase()}
                  </Button>
                ) : undefined
              }
            >
              <HitList group={group} scope={each} onSelect={select} selected={selectedHit ? selected : null} />
              {group.more && scope ? <p className="muted search-note">Showing the first {group.hits.length}. Add words to narrow the search.</p> : null}
            </Section>
          );
        })}
      </div>
    );
  }

  return (
    <Page title="Search">
      {/* one block holds the field, the tabs and the results, so the page sets their spacing and the tabs stay at
          the top while the results scroll. */}
      <div className="search-page">
        <div className="search-page-field" onKeyDown={onFieldKey}>
          <SearchField label="Search everything" placeholder="Search chats, runs, tool calls, memory…" value={text} onChange={onType} />
        </div>
        {q ? (
          <FilterBar label="search scopes">
            <Tabs label="Scope" items={tabs} value={tab} onChange={showScope} />
          </FilterBar>
        ) : null}
        {data?.mode === 'like' ? <p className="muted search-note">Short text: a plain match, not the full-text index.</p> : null}
        {body}
      </div>
      <DetailsPanel title={selectedHit ? selectedHit.title || selectedHit.id : 'Search'} openKey={opened} onClose={selectedHit ? () => setSelected(null) : undefined}>
        {selectedHit ? (
          <HitFacts hit={selectedHit} />
        ) : (
          <>
            {known ? (
              <Facts
                layout="stacked"
                items={SCOPES.map((each) => {
                  const group = known.find((g) => g.scope === each.id);
                  return { label: each.label, value: group ? countText(group) : '0' };
                })}
              />
            ) : null}
            <p className="muted">Choose the details button of a result to see where it comes from.</p>
          </>
        )}
      </DetailsPanel>
    </Page>
  );
}
