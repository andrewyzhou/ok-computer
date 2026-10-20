import { defineRoutes } from '../../routes';

// the desk of phase 6 t3: the board of delegations by status. the query of the hash holds the filters and the
// selection (status, person, q, id, and new=1 for the create form), so the page stays mounted while they change.
export default defineRoutes([{ path: 'desk', group: 'desk', label: 'Desk', icon: 'desk', order: 10, load: () => import('./DeskPage').then((m) => m.DeskPage) }]);
