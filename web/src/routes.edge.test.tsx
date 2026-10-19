import { describe, expect, it } from 'vitest';
import { buildRoutes, CORE_ROUTES, matchRoute, navSections, NAV_GROUPS, ROUTES, type RouteDef } from './routes';
import { hashPath, navRoute, parentRoute } from './shell/model';

// the edge cases of the route registry: the hashes that a person types or edits, the contract table of
// docs/PHASE5-API.md section 4, and the parent of each detail page.

const stub = (path: string, extra: Partial<RouteDef> = {}): RouteDef => ({
  path,
  group: null,
  label: path,
  icon: 'run',
  load: () => Promise.resolve(() => null),
  ...extra,
});

describe('the routes of the contract', () => {
  it('registers each route of section 4 with its group', () => {
    const want: Array<[string, string | null]> = [
      ['', 'today'],
      ['inbox', 'inbox'],
      ['inbox/newsletters', 'inbox'],
      ['inbox/subscriptions', 'inbox'],
      ['inbox/drafts', 'inbox'],
      ['inbox/proposals', 'inbox'],
      ['inbox/digests/:id', null],
      ['chats', 'chats'],
      ['chats/:key', null],
      ['activity', 'activity'],
      ['activity/:key', null],
      ['goals', 'agent'],
      ['memory', 'agent'],
      ['automations', 'agent'],
      ['signals', 'agent'],
      ['approvals', 'agent'],
      ['google', 'connections'],
      ['integrations', 'connections'],
      ['integrations/:id*', null],
      ['browser', 'connections'],
      ['browser/:id*', null],
      ['runs', 'dev'],
      ['runs/:id*', null],
      ['sessions', 'dev'],
      ['sessions/:sessionKey*', null],
      ['policy', 'dev'],
      ['cost', 'dev'],
      ['logs', 'dev'],
      ['sandbox', 'dev'],
      ['search', null],
      ['trace/:runId', null],
      ['trace/:runId/:spanId', null],
      ['sandbox/browser/:taskId', null],
      ['sandbox/code/:execId', null],
    ];
    for (const [path, group] of want) {
      const route = ROUTES.find((each) => each.path === path);
      expect(route, path).toBeDefined();
      expect(route!.group, path).toBe(group);
    }
  });

  it('marks the developer routes of the contract devOnly, and leaves the rest open in each mode', () => {
    const devOnly = ROUTES.filter((route) => route.devOnly).map((route) => route.path).sort();
    expect(devOnly).toEqual(['sandbox', 'sandbox/browser/:taskId', 'sandbox/code/:execId', 'trace/:runId', 'trace/:runId/:spanId'].sort());
  });

  it('has one route for each path, and a known nav group for each route', () => {
    const paths = ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    const groups = new Set<string | null>([...NAV_GROUPS.map((group) => group.id), null]);
    for (const route of ROUTES) expect(groups.has(route.group), route.path).toBe(true);
  });

  it('keeps the groups with no view out of the nav in each mode', () => {
    for (const dev of [true, false]) {
      const groups = navSections(dev).map((section) => section.group);
      for (const empty of ['desk', 'calendar', 'docs', 'people']) expect(groups).not.toContain(empty);
    }
  });

  it('opens a dev route by its hash outside developer mode', () => {
    expect(matchRoute('trace/run-1')?.route.path).toBe('trace/:runId');
    expect(matchRoute('sandbox/code/7')?.params).toEqual({ execId: '7' });
    expect(matchRoute('sandbox/browser/task-1')?.params).toEqual({ taskId: 'task-1' });
  });
});

describe('matchRoute with typed and edited hashes', () => {
  it('decodes an encoded chat key and span id', () => {
    expect(matchRoute('chats/main%400')?.params).toEqual({ key: 'main@0' });
    expect(matchRoute('trace/run-1/model%3A12')?.params).toEqual({ runId: 'run-1', spanId: 'model:12' });
    // the key of a background session holds a colon, and an encoded slash stays in one segment.
    expect(matchRoute('activity/auto%3Adaily%2Fbrief')?.params).toEqual({ key: 'auto:daily/brief' });
  });

  it('takes a chat key that is not encoded', () => {
    expect(matchRoute('chats/main@0')?.params).toEqual({ key: 'main@0' });
  });

  it('prefers the trace span route over the trace route, and the sandbox pages over the sandbox list', () => {
    expect(matchRoute('trace/run-1/tool:4')?.route.path).toBe('trace/:runId/:spanId');
    expect(matchRoute('sandbox')?.route.path).toBe('sandbox');
    expect(matchRoute('sandbox/browser/t')?.route.path).toBe('sandbox/browser/:taskId');
    expect(matchRoute('sandbox/other/t')).toBeUndefined();
  });

  it('prefers inbox/newsletters over inbox/digests/:id and keeps each inbox page apart', () => {
    expect(matchRoute('inbox')?.route.path).toBe('inbox');
    expect(matchRoute('inbox/newsletters')?.route.path).toBe('inbox/newsletters');
    expect(matchRoute('inbox/digests/12')?.params).toEqual({ id: '12' });
    expect(matchRoute('inbox/digests')).toBeUndefined();
  });

  it('reads the query of a hash and ignores it for the match', () => {
    const match = matchRoute('#/activity?kind=auto');
    expect(match?.route.path).toBe('activity');
    expect(match?.query.get('kind')).toBe('auto');
    expect(matchRoute('/search?q=a%20b&scope=runs')?.query.get('q')).toBe('a b');
    expect(matchRoute('?x=1')?.route.path).toBe('');
  });

  it('gives no match for an extra segment on a one-segment param', () => {
    expect(matchRoute('chats/main@0/extra')).toBeUndefined();
    expect(matchRoute('trace/run-1/model:1/more')).toBeUndefined();
  });

  it('keeps the rest of a star param with its slashes', () => {
    expect(matchRoute('integrations/mcp/server/a')?.params).toEqual({ id: 'mcp/server/a' });
    expect(matchRoute('sessions/sub%3Aplanner%3A1')?.params).toEqual({ sessionKey: 'sub:planner:1' });
  });

  it('builds the same registry when a view list is empty', () => {
    expect(buildRoutes(CORE_ROUTES, { './views/empty/routes.ts': { default: [] } })).toHaveLength(CORE_ROUTES.length);
  });

  it('ranks a view route with more fixed segments first, whatever the order of the list', () => {
    const routes = [stub('a/:x*'), stub('a/:x'), stub('a/b')];
    expect(matchRoute('a/b', routes)?.route.path).toBe('a/b');
    expect(matchRoute('a/c', routes)?.route.path).toBe('a/:x');
    expect(matchRoute('a/c/d', routes)?.route.path).toBe('a/:x*');
  });
});

describe('the nav order and the parents of detail pages', () => {
  it('lists the inbox pages in the order of the contract', () => {
    expect(navSections(false).find((section) => section.group === 'inbox')?.items.map((route) => route.path)).toEqual([
      'inbox',
      'inbox/newsletters',
      'inbox/subscriptions',
      'inbox/drafts',
      'inbox/proposals',
    ]);
  });

  it('lists the agent and connections pages in the order of the contract', () => {
    const labels = (group: string) => navSections(false).find((section) => section.group === group)?.items.map((route) => route.label);
    expect(labels('agent')).toEqual(['Goals', 'Memory', 'Automations', 'Signals', 'Approvals']);
    expect(labels('connections')).toEqual(['Google', 'Integrations', 'Browser']);
  });

  it('gives each detail page the nav item of its list', () => {
    const parent = (path: string) => parentRoute(ROUTES.find((route) => route.path === path)!, ROUTES)?.path;
    expect(parent('runs/:id*')).toBe('runs');
    expect(parent('inbox/digests/:id')).toBe('inbox');
    expect(parent('chats/:key')).toBe('chats');
    expect(parent('activity/:key')).toBe('activity');
    expect(parent('sandbox/code/:execId')).toBe('sandbox');
    expect(parent('sandbox/browser/:taskId')).toBe('sandbox');
    expect(parent('trace/:runId')).toBeUndefined();
    expect(navRoute(undefined, ROUTES)).toBeUndefined();
  });

  it('strips the hash prefix and the query for the page key', () => {
    expect(hashPath('#/search?q=x')).toBe('search');
    expect(hashPath('')).toBe('');
    expect(hashPath('#/')).toBe('');
    expect(hashPath('chats/main%400?x')).toBe('chats/main%400');
  });
});
