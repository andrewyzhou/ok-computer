// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedDashboard } from '../../test/seed';
import './testing';
import { buildRoutes, CORE_ROUTES, matchRoute, navSections, ROUTES, type RouteDef } from './routes';

vi.stubGlobal('EventSource', class {});
afterEach(() => cleanup());

const stub = (path: string, extra: Partial<RouteDef> = {}): RouteDef => ({
  path,
  group: null,
  label: path,
  icon: 'run',
  load: () => Promise.resolve(() => null),
  ...extra,
});

describe('the route registry', () => {
  it('matches every page from before phase 5', () => {
    for (const [hash, path, params] of [
      ['', '', {}],
      ['#/', '', {}],
      ['runs', 'runs', {}],
      ['runs/run-1', 'runs/:id*', { id: 'run-1' }],
      ['sessions/auto%3Adaily', 'sessions/:sessionKey*', { sessionKey: 'auto:daily' }],
      ['integrations/slack', 'integrations/:id*', { id: 'slack' }],
      ['browser/task-1', 'browser/:id*', { id: 'task-1' }],
      ['logs', 'logs', {}],
    ] as const) {
      const match = matchRoute(hash);
      expect(match?.route.path).toBe(path);
      expect(match?.params).toEqual(params);
    }
    expect(matchRoute('nowhere')).toBeUndefined();
  });

  it('prefers fixed segments and reads the query', () => {
    const routes = [...CORE_ROUTES, stub('runs/:id/trace')];
    expect(matchRoute('runs/run-1/trace', routes)?.route.path).toBe('runs/:id/trace');
    expect(matchRoute('runs/a/b', routes)?.params).toEqual({ id: 'a/b' });
    expect(matchRoute('search?q=essay', [stub('search')])?.query.get('q')).toBe('essay');
  });

  it('lets a view replace a core route and refuses two views with one path', () => {
    const view = stub('runs', { group: 'dev', label: 'Runs v2' });
    expect(buildRoutes(CORE_ROUTES, { './views/runs/routes.ts': { default: [view] } }).find((r) => r.path === 'runs')).toBe(view);
    expect(() =>
      buildRoutes(CORE_ROUTES, { './views/a/routes.ts': { default: [stub('x')] }, './views/b/routes.ts': { default: [stub('x')] } }),
    ).toThrow(/x/);
  });

  it('groups the nav and hides dev pages outside developer mode', () => {
    const routes = ROUTES;
    const dev = (on: boolean) => navSections(on, routes).find((s) => s.group === 'dev')?.items.map((r) => r.label);
    expect(dev(true)).toEqual(['Runs', 'Sessions', 'Policy', 'Cost', 'Logs', 'Sandbox']);
    expect(dev(false)).toBeUndefined();
    expect(navSections(false).map((s) => s.group)).toEqual(['today', 'desk', 'inbox', 'docs', 'people', 'chats', 'activity', 'agent', 'connections']);
    expect(navSections(true).map((s) => s.group)).toEqual(['today', 'desk', 'inbox', 'docs', 'people', 'chats', 'activity', 'agent', 'connections', 'dev']);
  });

  it('renders a core detail page with its param', async () => {
    const { dashboard } = await seedDashboard();
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => dashboard.request(String(input), init));
    const match = matchRoute('runs/run-1')!;
    const Page = await match.route.load();
    render(<Page params={match.params} query={match.query} />);
    expect(await screen.findByText('Timeline')).toBeTruthy();
  });
});
