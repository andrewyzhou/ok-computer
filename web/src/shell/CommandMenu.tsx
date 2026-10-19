import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons';
import { navSections, type RouteDef } from '../routes';
import { Highlight, KeyHint, useDialogFocus } from '../ui';
import { EXTENSIONS, type CommandGroup, type CommandItem, type CommandSource } from './extensions';
import { groupLabel } from './model';
import { setPrefs, toggleDevMode, usePrefs } from './prefs';

const SOURCES = EXTENSIONS.flatMap((extension) => extension.commandSources ?? []);
const EXTRA_COMMANDS = EXTENSIONS.flatMap((extension) => extension.commands ?? []);
const DEBOUNCE_MS = 150;

function matches(item: CommandItem, words: string[]): boolean {
  const detail = typeof item.detail === 'string' ? item.detail : (item.detail?.text ?? '');
  const hay = `${item.label} ${detail} ${item.keywords ?? ''}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

interface Remote {
  groups: CommandGroup[];
  error?: string;
  loading: boolean;
}

// the remote groups of each source for the text. an older text is aborted, so a slow answer never replaces a newer one.
function useSources(query: string, sources: CommandSource[]): Record<string, Remote> {
  const [state, setState] = useState<Record<string, Remote>>({});
  useEffect(() => {
    const text = query.trim();
    const active = sources.filter((source) => text.length >= (source.minQuery ?? 1));
    setState(Object.fromEntries(active.map((source) => [source.id, { groups: [], loading: true }])));
    if (!active.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // a source that throws at once is turned into a failed promise, so its error shows like a failed request.
      for (const source of active) {
        Promise.resolve().then(() => source.search(text, controller.signal)).then(
          (groups) => !controller.signal.aborted && setState((old) => ({ ...old, [source.id]: { groups, loading: false } })),
          (err: Error) =>
            !controller.signal.aborted && setState((old) => ({ ...old, [source.id]: { groups: [], loading: false, error: err.message } })),
        );
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, sources]);
  return state;
}

export function CommandMenu({
  open,
  onClose,
  routes,
  onToggleDetails,
  sources = SOURCES,
}: {
  open: boolean;
  onClose: () => void;
  routes: RouteDef[];
  onToggleDetails?: () => void;
  // the sources of the view folders. a test gives its own.
  sources?: CommandSource[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, open, onClose);
  if (!open) return null;
  return (
    <div className="cmdk-layer">
      <div className="scrim is-on" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu">
        <MenuBody onClose={onClose} routes={routes} onToggleDetails={onToggleDetails} sources={sources} />
      </div>
    </div>
  );
}

function MenuBody({
  onClose,
  routes,
  onToggleDetails,
  sources,
}: {
  onClose: () => void;
  routes: RouteDef[];
  onToggleDetails?: () => void;
  sources: CommandSource[];
}) {
  const { devMode, theme } = usePrefs();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const remote = useSources(query, sources);
  const list = useRef<HTMLDivElement>(null);

  const local = useMemo<CommandGroup[]>(() => {
    // the pages keep the order of the nav.
    const pages: CommandItem[] = navSections(devMode, routes)
      .flatMap((section) => section.items)
      .map((route) => ({ id: `page:${route.path}`, label: route.label, detail: groupLabel(route.group!), icon: route.icon, href: route.path }));
    const actions: CommandItem[] = [
      { id: 'dev', label: devMode ? 'Turn developer mode off' : 'Turn developer mode on', icon: 'dev', keywords: 'dev developer debug', run: toggleDevMode },
      ...(['light', 'dark', 'system'] as const)
        .filter((each) => each !== theme)
        .map((each) => ({
          id: `theme:${each}`,
          label: each === 'system' ? 'Use the system theme' : `Use the ${each} theme`,
          icon: each === 'light' ? ('sun' as const) : each === 'dark' ? ('moon' as const) : ('monitor' as const),
          keywords: 'theme appearance color',
          run: () => setPrefs({ theme: each }),
        })),
      ...(onToggleDetails ? [{ id: 'details', label: 'Show or hide the details panel', icon: 'panel' as const, keywords: 'details panel', run: onToggleDetails }] : []),
      ...EXTRA_COMMANDS,
    ];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [
      { id: 'pages', label: 'Go to', items: pages.filter((item) => matches(item, words)) },
      { id: 'actions', label: 'Actions', items: actions.filter((item) => matches(item, words)) },
    ].filter((group) => group.items.length);
  }, [routes, devMode, theme, query, onToggleDetails]);

  const remoteGroups = sources.flatMap((source) => {
    const state = remote[source.id];
    return state ? [{ source, state }] : [];
  });
  const groups = [...local, ...remoteGroups.flatMap(({ state }) => state.groups)];
  const flat: CommandItem[] = groups.flatMap((group) => [
    ...group.items,
    ...(group.more ? [{ id: `${group.id}:more`, label: group.more.label, href: group.more.href, icon: 'search' as const }] : []),
  ]);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const choose = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.href !== undefined) location.hash = `#/${item.href}`;
    else item.run?.();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + flat.length) % Math.max(flat.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(flat[current]);
    }
  };

  let index = -1;
  const option = (item: CommandItem) => {
    index += 1;
    const mine = index;
    return (
      <div
        key={item.id}
        id={`cmdk-${mine}`}
        role="option"
        aria-selected={mine === current}
        className={mine === current ? 'cmdk-item is-on' : 'cmdk-item'}
        onMouseMove={() => mine !== current && setActive(mine)}
        onClick={() => choose(item)}
      >
        {item.icon ? <Icon name={item.icon} size={16} /> : <span className="cmdk-noicon" />}
        <span className="cmdk-label">{item.label}</span>
        {item.detail ? (
          <span className="cmdk-detail">{typeof item.detail === 'string' ? item.detail : <Highlight text={item.detail.text} marks={item.detail.marks} />}</span>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="cmdk-input">
        <Icon name="search" size={18} />
        <input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={flat.length ? `cmdk-${current}` : undefined}
          aria-label="Search or run a command"
          placeholder="Search, or go to a page…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKey}
        />
        <KeyHint keys={['esc']} />
      </div>
      <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="results" ref={list}>
        {local.map((group) => (
          <div key={group.id} role="group" aria-label={group.label} className="cmdk-group">
            <div className="cmdk-group-label" aria-hidden="true">
              {group.label}
            </div>
            {group.items.map(option)}
          </div>
        ))}
        {remoteGroups.map(({ source, state }) => (
          <div key={source.id} className="cmdk-source">
            {state.loading ? <p className="cmdk-note">Searching {source.label.toLowerCase()}…</p> : null}
            {state.error ? <p className="cmdk-note error-text">{source.label}: {state.error}</p> : null}
            {state.groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label} className="cmdk-group">
                <div className="cmdk-group-label" aria-hidden="true">
                  {group.label}
                </div>
                {group.items.map(option)}
                {group.more ? option({ id: `${group.id}:more`, label: group.more.label, href: group.more.href, icon: 'search' }) : null}
              </div>
            ))}
          </div>
        ))}
        {!flat.length && !remoteGroups.some(({ state }) => state.loading) ? <p className="cmdk-note">Nothing matches “{query}”.</p> : null}
      </div>
      <footer className="cmdk-foot">
        <span>
          <KeyHint keys={['up', 'down']} /> move
        </span>
        <span>
          <KeyHint keys={['enter']} /> open
        </span>
        <span>
          <KeyHint keys={['mod', 'K']} /> close
        </span>
      </footer>
    </>
  );
}
