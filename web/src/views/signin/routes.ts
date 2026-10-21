import { defineRoutes } from '../../routes';

// Settings → Sign-in of track s1: the browsers that are signed in, with sign-out of one or of all.
export default defineRoutes([
  {
    path: 'settings/sign-in',
    group: 'agent',
    label: 'Sign-in',
    icon: 'session',
    order: 90,
    load: () => import('./SignInPage').then((m) => m.SignInPage),
  },
]);
