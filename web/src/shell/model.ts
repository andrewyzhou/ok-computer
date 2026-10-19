import { NAV_GROUPS, type IconName, type NavGroup, type RouteDef } from '../routes';

// the icon of each nav group in the rail.
export const GROUP_ICONS: Record<NavGroup, IconName> = {
  today: 'today',
  desk: 'desk',
  inbox: 'inbox',
  calendar: 'calendar',
  docs: 'docs',
  people: 'people',
  chats: 'chat',
  activity: 'activity',
  agent: 'agent',
  connections: 'connection',
  dev: 'dev',
};

export function groupLabel(group: NavGroup): string {
  return NAV_GROUPS.find((each) => each.id === group)?.label ?? group;
}

// a detail page has no group. its parent is the nav route with the longest path that is a start of its fixed
// segments, so runs/:id* has the parent runs and inbox/digests/:id has the parent inbox.
export function parentRoute(route: RouteDef, routes: RouteDef[]): RouteDef | undefined {
  if (route.group !== null) return undefined;
  const fixed: string[] = [];
  for (const part of route.path.split('/')) {
    if (part.startsWith(':')) break;
    fixed.push(part);
  }
  for (let length = fixed.length; length > 0; length--) {
    const path = fixed.slice(0, length).join('/');
    const parent = routes.find((each) => each.path === path && each.group !== null);
    if (parent) return parent;
  }
  return undefined;
}

// the nav item that shows as current: the route itself, or the parent of a detail page.
export function navRoute(route: RouteDef | undefined, routes: RouteDef[]): RouteDef | undefined {
  if (!route) return undefined;
  return route.group !== null ? route : parentRoute(route, routes);
}

export function routeHref(route: RouteDef): string {
  return `#/${route.path}`;
}

export function hashPath(hash: string): string {
  return hash.replace(/^#?\/?/, '').split('?', 1)[0] ?? '';
}
