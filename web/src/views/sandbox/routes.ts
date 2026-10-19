import { defineRoutes } from '../../routes';

// the sandbox of developer mode: the open browser tasks and the code runs, with a page for one of each.
export default defineRoutes([
  {
    path: 'sandbox',
    group: 'dev',
    label: 'Sandbox',
    icon: 'sandbox',
    devOnly: true,
    order: 60,
    load: () => import('./SandboxPage').then((m) => m.SandboxPage),
  },
  {
    path: 'sandbox/browser/:taskId',
    group: null,
    label: 'Browser task',
    icon: 'browser',
    devOnly: true,
    load: () => import('./BrowserTaskPage').then((m) => m.BrowserTaskPage),
  },
  {
    path: 'sandbox/code/:execId',
    group: null,
    label: 'Code run',
    icon: 'sandbox',
    devOnly: true,
    load: () => import('./CodeRunPage').then((m) => m.CodeRunPage),
  },
]);
