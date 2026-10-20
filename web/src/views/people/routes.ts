import { defineRoutes, type RouteDef } from '../../routes';

// the people memory of phase 6 t5: a searchable list, and the profile of one person in the details panel. both routes
// give one page, so opening a profile keeps the list, its search and its scroll.
const load: RouteDef['load'] = () => import('./PeoplePage').then((m) => m.PeoplePage);
const pageKey: RouteDef['pageKey'] = () => 'people';

export default defineRoutes([
  { path: 'people', group: 'people', label: 'People', icon: 'people', order: 10, load, pageKey },
  { path: 'people/:id', group: null, label: 'Person', icon: 'people', load, pageKey },
]);
