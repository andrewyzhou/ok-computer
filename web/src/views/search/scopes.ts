import type { SearchResults, SearchScope } from '../../../../src/dashboard/types';
import type { IconName } from '../../routes';
import type { CommandGroup } from '../../shell/extensions';

export interface ScopeDef {
  id: SearchScope;
  label: string;
  icon: IconName;
}

// the scopes of the search, in the order of SearchScope, which is the order of the groups in each answer.
export const SCOPES: readonly ScopeDef[] = [
  { id: 'messages', label: 'Messages', icon: 'chat' },
  { id: 'runs', label: 'Runs', icon: 'run' },
  { id: 'tools', label: 'Tool calls', icon: 'integration' },
  { id: 'automations', label: 'Automations', icon: 'automation' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'approvals', label: 'Approvals', icon: 'approval' },
];

// the server takes at most 200 characters, so a longer text is cut here and never gets a 400.
export const MAX_QUERY = 200;

// a value that is not a scope gives undefined, so an old or edited link shows every scope.
export function scopeOf(value: string | null | undefined): ScopeDef | undefined {
  return SCOPES.find((scope) => scope.id === value);
}

// the hash route of the search page without #/. an empty text or scope is left out of the query.
export function searchHref(q: string, scope?: SearchScope): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (scope) params.set('scope', scope);
  const query = params.toString();
  return query ? `search?${query}` : 'search';
}

// the groups of the command menu for one answer. a scope with no hits is left out, and the last group always links to
// the search page, so the full list is one key away even when the menu shows no hit.
export function toCommandGroups(results: SearchResults, q: string): CommandGroup[] {
  const groups: CommandGroup[] = [];
  for (const group of results.groups) {
    const scope = scopeOf(group.scope);
    if (!scope || group.hits.length === 0) continue;
    groups.push({
      id: `search:${scope.id}`,
      label: scope.label,
      items: group.hits.map((hit) => ({
        id: `${scope.id}:${hit.id}`,
        label: hit.title,
        detail: { text: hit.snippet, marks: hit.marks },
        icon: scope.icon,
        href: hit.href,
      })),
      more: group.more ? { label: `All ${scope.label.toLowerCase()} for “${q}”`, href: searchHref(q, scope.id) } : undefined,
    });
  }
  groups.push({
    id: 'search:all',
    label: 'Search',
    items: [{ id: 'search:all', label: `All results for “${q}”`, icon: 'search', href: searchHref(q) }],
  });
  return groups;
}
