import { defineRoutes } from '../../routes';

// the search page is the full list behind the command menu. it has no nav group, because the menu and the header
// open it.
export default defineRoutes([
  {
    path: 'search',
    group: null,
    label: 'Search',
    icon: 'search',
    load: () => import('./SearchPage').then((m) => m.SearchPage),
  },
]);
