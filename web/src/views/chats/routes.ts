import { createElement } from 'react';
import { defineRoutes } from '../../routes';

// the chats of the owner. #/chats opens the newest main chat, and #/chats/<key> one segment of it. the router decodes
// the key, and each link encodes it again. the nav group is the only crumb of a chat, because the group and its list
// have the same name.
export default defineRoutes([
  {
    path: 'chats',
    group: 'chats',
    label: 'Chats',
    icon: 'chat',
    order: 10,
    load: () => import('./ChatsHome').then((m) => m.ChatsHome),
  },
  {
    path: 'chats/:key',
    group: null,
    label: 'Chat',
    icon: 'chat',
    load: () => import('./ChatView').then((m) => ({ params }) => createElement(m.ChatView, { chatKey: params.key ?? '', crumbs: [] })),
  },
]);
