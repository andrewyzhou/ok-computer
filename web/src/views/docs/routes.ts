import { defineRoutes } from '../../routes';

// the docs of phase 6 t4: the list with kind and search, and one doc with its versions, its diff and the owner's
// comments. a ?version=N in the query of a doc picks that version, and it keeps the page mounted.
export default defineRoutes([
  { path: 'docs', group: 'docs', label: 'Docs', icon: 'docs', order: 10, load: () => import('./DocsList').then((m) => m.DocsListPage) },
  {
    path: 'docs/:id',
    group: null,
    label: 'Doc',
    icon: 'docs',
    load: () => import('./DocPage').then((m) => m.DocPage),
    pageKey: (params) => `docs/${params.id ?? ''}`,
  },
]);
