import { defineRoutes } from '../../routes';

// the inbox views of m8. the backend jobs fill the tables, and these pages show them and send the owner's actions,
// each of which asks for an approval first when it changes mail or an account.
export default defineRoutes([
  { path: 'inbox', group: 'inbox', label: 'Digest', icon: 'inbox', order: 10, load: () => import('./Digest').then((m) => m.DigestPage) },
  { path: 'inbox/digests/:id', group: null, label: 'Digest', icon: 'inbox', load: () => import('./Digest').then((m) => m.DigestPage) },
  {
    path: 'inbox/newsletters',
    group: 'inbox',
    label: 'Newsletters',
    icon: 'mail',
    order: 20,
    load: () => import('./Newsletters').then((m) => m.NewslettersPage),
  },
  {
    path: 'inbox/subscriptions',
    group: 'inbox',
    label: 'Subscriptions',
    icon: 'subscription',
    order: 30,
    load: () => import('./Subscriptions').then((m) => m.SubscriptionsPage),
  },
  { path: 'inbox/drafts', group: 'inbox', label: 'Drafts', icon: 'draft', order: 40, load: () => import('./Drafts').then((m) => m.DraftsPage) },
  {
    path: 'inbox/proposals',
    group: 'inbox',
    label: 'Proposals',
    icon: 'calendar',
    order: 50,
    load: () => import('./Proposals').then((m) => m.ProposalsPage),
  },
]);
