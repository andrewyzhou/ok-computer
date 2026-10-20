import { createElement, type ComponentType } from 'react';
import { defineRoutes, type RouteDef, type RouteProps } from '../../routes';

// the today page of phase 6 t1: the stored morning brief of a day. it is the home page, so the empty path replaces
// the core overview, which moves to overview in the agent group. today/:day shows the brief of that day, which is the
// link of the telegram message. the three paths have one page key, so a new day changes the page in place.
const TodayPage: RouteDef['load'] = () => import('./TodayPage').then((m) => m.TodayPage);

// the overview takes partial route props, so it gets the same wrapper as a core page in web/src/routes.ts.
function page(load: () => Promise<ComponentType<Partial<RouteProps>>>): RouteDef['load'] {
  return () => load().then((Page) => (props: RouteProps) => createElement(Page, props));
}

export default defineRoutes([
  { path: '', group: null, label: 'Today', icon: 'today', pageKey: () => 'today', load: TodayPage },
  { path: 'today', group: 'today', label: 'Today', icon: 'today', order: 10, pageKey: () => 'today', load: TodayPage },
  { path: 'today/:day', group: null, label: 'Today', icon: 'today', pageKey: () => 'today', load: TodayPage },
  {
    path: 'overview',
    group: 'agent',
    label: 'Overview',
    icon: 'overview',
    order: 5,
    load: page(() => import('../../pages/Overview').then((m) => m.Overview)),
  },
]);
