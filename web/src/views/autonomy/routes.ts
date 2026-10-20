import { defineRoutes } from '../../routes';

// the trust ladder of phase 6 (track T6): the level of each domain, its history, and the only control that raises a
// level.
export default defineRoutes([
  {
    path: 'autonomy',
    group: 'agent',
    label: 'Autonomy',
    icon: 'policy',
    order: 60,
    load: () => import('./AutonomyPage').then((m) => m.AutonomyPage),
  },
]);
