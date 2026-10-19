import type { SearchResults } from '../../../../src/dashboard/types';
import { api } from '../../api';
import { defineShellExtension } from '../../shell/extensions';
import { MAX_QUERY, toCommandGroups } from './scopes';

// the full-text search in the command menu. the menu waits for the last key and aborts an older request, so the
// source only asks the server. a failed request throws, and the menu shows the error in place of the groups.
export default defineShellExtension({
  commandSources: [
    {
      id: 'search',
      label: 'Search',
      minQuery: 1,
      search: (query, signal) => {
        const q = query.slice(0, MAX_QUERY);
        return api<SearchResults>(`/api/search?q=${encodeURIComponent(q)}&limit=5`, { signal }).then((results) => toCommandGroups(results, q));
      },
    },
  ],
});
