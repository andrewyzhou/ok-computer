import { useEffect, useState, type ComponentType } from 'react';
import type { Meta } from '../../src/dashboard/types';
import { useApi } from './api';
import { setTimeZone } from './format';
import { matchRoute, ROUTES, type RouteDef, type RouteMatch, type RouteProps } from './routes';
import { Shell } from './shell/Shell';
import { hashPath } from './shell/model';
import { EmptyState, Skeleton } from './ui';

// the routes live in the hash, so the server needs to serve only index.html and the assets.
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

// a route loads its component one time. the next visit renders it at once.
const loaded = new Map<RouteDef, ComponentType<RouteProps>>();

function RouteView({ match }: { match: RouteMatch }) {
  const [View, setView] = useState<ComponentType<RouteProps> | undefined>(() => loaded.get(match.route));
  const [error, setError] = useState('');
  useEffect(() => {
    if (View) return;
    let current = true;
    match.route.load().then(
      (component) => {
        loaded.set(match.route, component);
        if (current) setView(() => component);
      },
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [match.route, View]);
  if (error) return <p className="error-box">Could not load the page: {error}</p>;
  if (!View) return <Skeleton lines={5} />;
  return <View params={match.params} query={match.query} />;
}

export function App() {
  const hash = useHash();
  const match = matchRoute(hash);
  const meta = useApi<Meta>('/api/meta');
  if (meta.data) setTimeZone(meta.data.timeZone);
  return (
    <Shell match={match} routes={ROUTES}>
      {meta.error ? (
        <p className="error-box">Could not load: {meta.error}</p>
      ) : !meta.data ? (
        <Skeleton lines={5} />
      ) : match ? (
        // the key is the path without the query, so a new param gives a new page and a new filter keeps the page.
        <RouteView key={hashPath(hash)} match={match} />
      ) : (
        <EmptyState icon="search" title="This page does not exist.">
          <a href="#/">Go to the overview</a>
        </EmptyState>
      )}
    </Shell>
  );
}
