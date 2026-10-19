import { defineRoutes } from '../../routes';

// the inbox pages of phase 5 m8. docs/PHASE5-API.md section 4 gives the paths. each loader imports its page only when
// the owner opens it.
export default defineRoutes([
  { path: 'inbox', group: 'inbox', label: 'Digest', icon: 'inbox', order: 10, load: () => import('./Digest').then((m) => m.Digest) },
  {
    path: 'inbox/newsletters',
    group: 'inbox',
    label: 'Newsletters',
    icon: 'mail',
    order: 20,
    load: () => import('./Newsletters').then((m) => m.Newsletters),
  },
  {
    path: 'inbox/subscriptions',
    group: 'inbox',
    label: 'Subscriptions',
    icon: 'subscription',
    order: 30,
    load: () => import('./Subscriptions').then((m) => m.Subscriptions),
  },
  { path: 'inbox/drafts', group: 'inbox', label: 'Drafts', icon: 'draft', order: 40, load: () => import('./Drafts').then((m) => m.Drafts) },
  {
    path: 'inbox/proposals',
    group: 'inbox',
    label: 'Proposals',
    icon: 'calendar',
    order: 50,
    load: () => import('./Proposals').then((m) => m.Proposals),
  },
  { path: 'inbox/digests/:id', group: null, label: 'Digest', icon: 'inbox', load: () => import('./Digest').then((m) => m.Digest) },
]);
