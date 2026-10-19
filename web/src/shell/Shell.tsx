import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { navSections, pageKeyOf, type RouteDef, type RouteMatch } from '../routes';
import { hasMod, IconButton, useDialogFocus } from '../ui';
import { CommandMenu } from './CommandMenu';
import { ShellContext, type Crumb, type PageInfo, type ShellApi } from './context';
import { groupLabel, navRoute, parentRoute, routeHref } from './model';
import { Nav, Rail } from './Nav';
import { setPrefs, toggleDevMode, usePrefs } from './prefs';
import { StatusBar } from './StatusBar';

// the widths where the layout changes. they match the media queries in styles.css.
const DRAWER_BELOW = 1100;
const SHEET_BELOW = 760;

function narrowerThan(width: number): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(`(max-width: ${width - 0.02}px)`).matches;
}

// the same test as narrowerThan, as state that follows a resize, so the dialog roles leave a panel that is inline
// again.
function useNarrowerThan(width: number): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof globalThis.matchMedia !== 'function') return () => {};
      const query = globalThis.matchMedia(`(max-width: ${width - 0.02}px)`);
      query.addEventListener?.('change', listener);
      return () => query.removeEventListener?.('change', listener);
    },
    () => narrowerThan(width),
    () => false,
  );
}

function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return Boolean(node && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)));
}

function breadcrumb(match: RouteMatch | undefined, routes: RouteDef[], page: PageInfo | null): Crumb[] {
  if (!match) return [];
  const item = navRoute(match.route, routes);
  const crumbs: Crumb[] = [];
  if (item?.group) {
    const first = navSections(true, routes).find((section) => section.group === item.group)?.items[0];
    crumbs.push({ label: groupLabel(item.group), ...(first ? { href: routeHref(first) } : {}) });
  }
  if (page?.crumbs) crumbs.push(...page.crumbs);
  else {
    const parent = parentRoute(match.route, routes);
    if (parent) crumbs.push({ label: parent.label, href: routeHref(parent) });
  }
  return crumbs;
}

export function Shell({ match, routes, children }: { match: RouteMatch | undefined; routes: RouteDef[]; children: ReactNode }) {
  const { devMode, detailsHidden } = usePrefs();
  const [page, setPageState] = useState<PageInfo | null>(null);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const [detailsCount, setDetailsCount] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const detailsRef = useCallback((node: HTMLElement | null) => {
    drawer.current = node;
    setDetails(node);
  }, []);

  const api = useMemo<ShellApi>(
    () => ({
      headerActions,
      details,
      setPage: (info) =>
        setPageState((old) => (old && info && old.title === info.title && JSON.stringify(old.crumbs) === JSON.stringify(info.crumbs) ? old : info)),
      registerDetails: () => {
        setDetailsCount((count) => count + 1);
        return () => setDetailsCount((count) => count - 1);
      },
      openDetails: () => narrowerThan(DRAWER_BELOW) && setDetailsOpen(true),
      closeDetails: () => setDetailsOpen(false),
    }),
    [headerActions, details],
  );

  const toggleDetails = useCallback(() => {
    if (narrowerThan(DRAWER_BELOW)) setDetailsOpen((open) => !open);
    else setPrefs({ detailsHidden: !detailsHidden });
  }, [detailsHidden]);

  // a new page starts at the top, with the sheet and the drawer closed. a page that stays, for example a trace with a
  // new span, keeps its scroll.
  const path = match ? pageKeyOf(match) : '';
  useEffect(() => {
    setSheetOpen(false);
    setDetailsOpen(false);
    main.current?.scrollTo?.(0, 0);
  }, [path]);

  useEffect(() => {
    document.title = page?.title ? `${page.title} · ok computer` : 'ok computer';
  }, [page?.title]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (hasMod(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMenuOpen((open) => !open);
      } else if (hasMod(event) && event.key === '.') {
        event.preventDefault();
        toggleDevMode();
      } else if (event.key === '/' && !typing(event.target) && !hasMod(event)) {
        event.preventDefault();
        if (narrowerThan(SHEET_BELOW)) setSheetOpen(true);
        search.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const sheetNarrow = useNarrowerThan(SHEET_BELOW);
  const drawerNarrow = useNarrowerThan(DRAWER_BELOW);
  // a sheet or a drawer that the owner opened on a narrow screen closes when the screen gets wide.
  useEffect(() => {
    if (!sheetNarrow) setSheetOpen(false);
  }, [sheetNarrow]);
  useEffect(() => {
    if (!drawerNarrow) setDetailsOpen(false);
  }, [drawerNarrow]);
  const sheetActive = sheetOpen && sheetNarrow;
  const drawerActive = detailsOpen && drawerNarrow;
  useDialogFocus(sheet, sheetActive, () => setSheetOpen(false));
  useDialogFocus(drawer, drawerActive, () => setDetailsOpen(false));

  const sections = navSections(devMode, routes);
  const current = navRoute(match?.route, routes);
  const crumbs = breadcrumb(match, routes, page);
  const hasDetails = detailsCount > 0;
  const closeSheet = () => setSheetOpen(false);

  return (
    <ShellContext.Provider value={api}>
      <div
        className="app"
        data-details={hasDetails ? (detailsHidden ? 'hidden' : 'on') : 'none'}
        data-sheet={sheetOpen ? 'open' : 'closed'}
        data-drawer={detailsOpen ? 'open' : 'closed'}
        data-dev={devMode ? 'on' : 'off'}
      >
        <a
          className="skip-link"
          href="#main"
          onClick={(event) => {
            // the hash holds the route, so the link moves the focus instead of the hash.
            event.preventDefault();
            main.current?.focus();
          }}
        >
          Skip to the content
        </a>
        <div
          className="navpane"
          ref={sheet}
          {...(sheetActive ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'navigation' } : {})}
        >
          <nav className="railpane" aria-label="sections">
            <Rail sections={sections} current={current} onSearch={() => setMenuOpen(true)} />
          </nav>
          <nav className="sidenav" aria-label="pages">
            <Nav
              sections={sections}
              current={current}
              filter={filter}
              onFilter={setFilter}
              devMode={devMode}
              onNavigate={closeSheet}
              searchRef={search}
            />
          </nav>
          <IconButton icon="close" label="Close the navigation" className="sheet-close" onClick={closeSheet} />
        </div>
        <div className="workspace">
          <header className="topbar">
            <IconButton
              icon="menu"
              label="Open the navigation"
              className="only-sheet"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen(true)}
            />
            <nav className="crumbs" aria-label="breadcrumb">
              <ol>
                {crumbs.map((crumb, index) => (
                  <li key={index} className="crumb">
                    {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}
                  </li>
                ))}
                {page?.title ? (
                  <li className="crumb crumb-current" aria-current="page">
                    {page.title}
                  </li>
                ) : null}
              </ol>
            </nav>
            <div className="topbar-actions" ref={setHeaderActions} />
            <IconButton icon="search" label="Search and commands" className="only-sheet" onClick={() => setMenuOpen(true)} />
            {hasDetails ? (
              <IconButton
                icon="panel"
                label="Show or hide the details"
                className="details-toggle"
                onClick={toggleDetails}
              />
            ) : null}
          </header>
          <main id="main" className="content" ref={main} tabIndex={-1}>
            {children}
          </main>
        </div>
        <aside
          className="details"
          aria-label="details"
          ref={detailsRef}
          {...(drawerActive ? { role: 'dialog', 'aria-modal': true } : {})}
        />
        <div
          className="scrim"
          aria-hidden="true"
          onClick={() => {
            setSheetOpen(false);
            setDetailsOpen(false);
          }}
        />
        <StatusBar onSearch={() => setMenuOpen(true)} />
        <CommandMenu open={menuOpen} onClose={() => setMenuOpen(false)} routes={routes} onToggleDetails={hasDetails ? toggleDetails : undefined} />
      </div>
    </ShellContext.Provider>
  );
}
