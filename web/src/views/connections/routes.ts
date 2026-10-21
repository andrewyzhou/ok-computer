import { defineRoutes } from '../../routes';

// the connections hub (docs/CONNECT-PLAN.md, track S2): a card with a Connect button for each service. the id in the
// query opens the details panel of one card, so the page stays mounted when the owner opens a card.
export default defineRoutes([
  {
    path: 'connections',
    group: 'connections',
    label: 'Connections',
    icon: 'connection',
    order: 5,
    load: () => import('./ConnectionsPage').then((m) => m.ConnectionsPage),
  },
]);
