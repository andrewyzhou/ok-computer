import { createElement, type ComponentType } from 'react';

// the route registry of the web app. each view folder web/src/views/<area>/ has a routes.ts with a default export of
// RouteDef[], and this file collects them, so a team adds a page with no edit to a shared file. the pages from before
// phase 5 are the core routes below. a view route with the same path as a core route takes its place, so a restyled
// page replaces the old one. docs/PHASE5-API.md lists the routes of each milestone.

// the groups of the left nav, in the order of the nav. a group shows only when it has a route.
export type NavGroup = 'today' | 'desk' | 'inbox' | 'calendar' | 'docs' | 'people' | 'chats' | 'activity' | 'agent' | 'connections' | 'dev';

export const NAV_GROUPS: ReadonlyArray<{ id: NavGroup; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'desk', label: 'Desk' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'docs', label: 'Docs' },
  { id: 'people', label: 'People' },
  { id: 'chats', label: 'Chats' },
  { id: 'activity', label: 'Activity' },
  { id: 'agent', label: 'Agent' },
  { id: 'connections', label: 'Connections' },
  { id: 'dev', label: 'Dev' },
];

// the names of the inline svg icons. the m3 shell draws one icon for each name, and a new name goes here first.
export type IconName =
  | 'today'
  | 'desk'
  | 'inbox'
  | 'calendar'
  | 'docs'
  | 'people'
  | 'chat'
  | 'activity'
  | 'goal'
  | 'memory'
  | 'automation'
  | 'signal'
  | 'approval'
  | 'google'
  | 'integration'
  | 'browser'
  | 'run'
  | 'session'
  | 'policy'
  | 'cost'
  | 'log'
  | 'trace'
  | 'sandbox'
  | 'search'
  | 'mail'
  | 'subscription'
  | 'draft';

// params holds the decoded values of the :name segments of the path. query is the part of the hash after a ?.
export interface RouteProps {
  params: Record<string, string>;
  query: URLSearchParams;
}

export interface RouteDef {
  // the hash path without #/, for example runs or runs/:id. a :name segment matches one segment. a last segment
  // :name* matches the rest of the path, with its slashes. the empty path is the home page.
  path: string;
  // the nav group of the page. a detail page has null, and the nav does not list it.
  group: NavGroup | null;
  label: string;
  icon: IconName;
  // the loader gives the component. the shell renders it with the key of the full path, so a new param gives a new
  // component.
  load: () => Promise<ComponentType<RouteProps>>;
  // a dev page is in the nav and in the command menu only in developer mode. its hash opens it in each mode.
  devOnly?: boolean;
  // the place in its group. a lower number comes first, and the default is 100.
  order?: number;
}

// a helper that gives a view's list its type.
export function defineRoutes(routes: RouteDef[]): RouteDef[] {
  return routes;
}

// a core route wraps a page from web/src/pages. a detail page takes its param as the prop with the same name.
function page(load: () => Promise<ComponentType>): RouteDef['load'] {
  return () => load().then((Page) => () => createElement(Page));
}

function detail<K extends string>(prop: K, load: () => Promise<ComponentType<Record<K, string>>>): RouteDef['load'] {
  return () => load().then((Page) => ({ params }: RouteProps) => createElement(Page, { [prop]: params[prop] ?? '' } as Record<K, string>));
}

export const CORE_ROUTES: RouteDef[] = [
  { path: '', group: 'today', label: 'Overview', icon: 'today', load: page(() => import('./pages/Overview').then((m) => m.Overview)) },
  { path: 'goals', group: 'agent', label: 'Goals', icon: 'goal', order: 10, load: page(() => import('./pages/Goals').then((m) => m.Goals)) },
  { path: 'memory', group: 'agent', label: 'Memory', icon: 'memory', order: 20, load: page(() => import('./pages/Memory').then((m) => m.Memory)) },
  {
    path: 'automations',
    group: 'agent',
    label: 'Automations',
    icon: 'automation',
    order: 30,
    load: page(() => import('./pages/Automations').then((m) => m.Automations)),
  },
  { path: 'signals', group: 'agent', label: 'Signals', icon: 'signal', order: 40, load: page(() => import('./pages/Google').then((m) => m.Signals)) },
  {
    path: 'approvals',
    group: 'agent',
    label: 'Approvals',
    icon: 'approval',
    order: 50,
    load: page(() => import('./pages/Approvals').then((m) => m.Approvals)),
  },
  { path: 'google', group: 'connections', label: 'Google', icon: 'google', order: 10, load: page(() => import('./pages/Google').then((m) => m.Google)) },
  {
    path: 'integrations',
    group: 'connections',
    label: 'Integrations',
    icon: 'integration',
    order: 20,
    load: page(() => import('./pages/Integrations').then((m) => m.Integrations)),
  },
  {
    path: 'integrations/:id*',
    group: null,
    label: 'Integration',
    icon: 'integration',
    load: detail('id', () => import('./pages/Integrations').then((m) => m.IntegrationDetail)),
  },
  {
    path: 'browser',
    group: 'connections',
    label: 'Browser',
    icon: 'browser',
    order: 30,
    load: page(() => import('./pages/Browser').then((m) => m.BrowserTasks)),
  },
  {
    path: 'browser/:id*',
    group: null,
    label: 'Browser task',
    icon: 'browser',
    load: detail('id', () => import('./pages/Browser').then((m) => m.BrowserTask)),
  },
  { path: 'runs', group: 'dev', label: 'Runs', icon: 'run', order: 10, load: page(() => import('./pages/Runs').then((m) => m.Runs)) },
  {
    path: 'runs/:id*',
    group: null,
    label: 'Run',
    icon: 'run',
    load: detail('id', () => import('./pages/RunDetail').then((m) => m.RunDetail)),
  },
  { path: 'sessions', group: 'dev', label: 'Sessions', icon: 'session', order: 20, load: page(() => import('./pages/Sessions').then((m) => m.Sessions)) },
  {
    path: 'sessions/:sessionKey*',
    group: null,
    label: 'Session',
    icon: 'session',
    load: detail('sessionKey', () => import('./pages/Sessions').then((m) => m.SessionDetail)),
  },
  { path: 'policy', group: 'dev', label: 'Policy', icon: 'policy', order: 30, load: page(() => import('./pages/Policy').then((m) => m.Policy)) },
  { path: 'cost', group: 'dev', label: 'Cost', icon: 'cost', order: 40, load: page(() => import('./pages/Cost').then((m) => m.Cost)) },
  { path: 'logs', group: 'dev', label: 'Logs', icon: 'log', order: 50, load: page(() => import('./pages/Logs').then((m) => m.Logs)) },
];

// the routes of the view folders. vite finds them when it builds, so a new folder needs no import here.
const viewModules = import.meta.glob<{ default: RouteDef[] }>('./views/*/routes.ts', { eager: true });

// a later list replaces a route of an earlier list with the same path. two views with the same path are an error,
// because each path has one owner.
export function buildRoutes(core: RouteDef[], views: Record<string, { default: RouteDef[] }>): RouteDef[] {
  const byPath = new Map(core.map((route) => [route.path, route]));
  const fromView = new Map<string, string>();
  for (const [file, module] of Object.entries(views)) {
    for (const route of module.default) {
      const owner = fromView.get(route.path);
      if (owner) throw new Error(`the route ${route.path} is in ${owner} and in ${file}`);
      fromView.set(route.path, file);
      byPath.set(route.path, route);
    }
  }
  return [...byPath.values()];
}

export const ROUTES: RouteDef[] = buildRoutes(CORE_ROUTES, viewModules);

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
  query: URLSearchParams;
}

function matchPath(pattern: string, segments: string[]): Record<string, string> | undefined {
  const parts = pattern === '' ? [] : pattern.split('/');
  const params: Record<string, string> = {};
  for (const [index, part] of parts.entries()) {
    if (part.startsWith(':') && part.endsWith('*') && index === parts.length - 1) {
      const rest = segments.slice(index);
      if (rest.length === 0) return undefined;
      params[part.slice(1, -1)] = decodeURIComponent(rest.join('/'));
      return params;
    }
    const segment = segments[index];
    if (segment === undefined) return undefined;
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segment);
    else if (part !== segment) return undefined;
  }
  return parts.length === segments.length ? params : undefined;
}

// a path with more fixed segments comes first, so runs/:id/trace wins over runs/:id*.
function rank(pattern: string): number {
  if (pattern === '') return 0;
  return pattern.split('/').reduce((sum, part) => sum + (part.endsWith('*') ? 1 : part.startsWith(':') ? 10 : 100), 0);
}

// the hash is the part after #/, for example runs/run-1 or search?q=essay.
export function matchRoute(hash: string, routes: RouteDef[] = ROUTES): RouteMatch | undefined {
  const [path = '', search = ''] = hash.replace(/^#?\/?/, '').split('?', 2);
  const segments = path === '' ? [] : path.split('/');
  const sorted = [...routes].sort((a, b) => rank(b.path) - rank(a.path));
  for (const route of sorted) {
    const params = matchPath(route.path, segments);
    if (params) return { route, params, query: new URLSearchParams(search) };
  }
  return undefined;
}

export interface NavSection {
  group: NavGroup;
  label: string;
  items: RouteDef[];
}

// the nav lists each route with a group, in the order of NAV_GROUPS and then of order and label. a group with no route
// is left out.
export function navSections(devMode: boolean, routes: RouteDef[] = ROUTES): NavSection[] {
  return NAV_GROUPS.map(({ id, label }) => ({
    group: id,
    label,
    items: routes
      .filter((route) => route.group === id && (devMode || !route.devOnly))
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label)),
  })).filter((section) => section.items.length > 0);
}
