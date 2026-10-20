import { defineRoutes } from '../../routes';

// the today page of phase 6 t1: the stored morning brief of a day. today/:day shows the brief of that day, which is
// the link of the telegram message. both paths have one page key, so a new day changes the page in place.
export default defineRoutes([
  { path: 'today', group: 'today', label: 'Today', icon: 'today', order: 10, pageKey: () => 'today', load: () => import('./TodayPage').then((m) => m.TodayPage) },
  { path: 'today/:day', group: null, label: 'Today', icon: 'today', pageKey: () => 'today', load: () => import('./TodayPage').then((m) => m.TodayPage) },
]);
