import { defineRoutes, type RouteDef } from '../../routes';

// the trace of a run, and the same page with one span open. the span id has a colon, for example model:12, so the
// hash holds it encoded and the router decodes it.
const load: RouteDef['load'] = () => import('./TracePage').then((m) => m.TracePage);
// both routes give one page for each run, so a click on a span keeps the waterfall, its scroll and its data.
const pageKey: RouteDef['pageKey'] = (params) => `trace:${params.runId ?? ''}`;

export default defineRoutes([
  { path: 'trace/:runId', group: null, label: 'Trace', icon: 'trace', devOnly: true, load, pageKey },
  { path: 'trace/:runId/:spanId', group: null, label: 'Span', icon: 'trace', devOnly: true, load, pageKey },
]);
