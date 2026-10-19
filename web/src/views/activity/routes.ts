import { createElement } from 'react';
import { defineRoutes } from '../../routes';

// the background sessions: automations, heartbeats, sub-agents, consolidation, workshop and polls. ?kind= picks one
// kind, and #/activity/<key> opens the transcript of one session, read-only.
export default defineRoutes([
  {
    path: 'activity',
    group: 'activity',
    label: 'Activity',
    icon: 'activity',
    load: () => import('./ActivityList').then((m) => m.ActivityList),
  },
  {
    path: 'activity/:key',
    group: null,
    label: 'Activity',
    icon: 'activity',
    load: () => import('./ActivityList').then((m) => ({ params }) => createElement(m.ActivityChat, { chatKey: params.key ?? '' })),
  },
]);
