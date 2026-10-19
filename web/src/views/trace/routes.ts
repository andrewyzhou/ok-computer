import { defineRoutes, type RouteDef } from '../../routes';

// the trace of a run, and the same page with one span open. the span id has a colon, for example model:12, so the
// hash holds it encoded and the router decodes it.
const load: RouteDef['load'] = () => import('./TracePage').then((m) => m.TracePage);

export default defineRoutes([
  { path: 'trace/:runId', group: null, label: 'Trace', icon: 'trace', devOnly: true, load },
  { path: 'trace/:runId/:spanId', group: null, label: 'Span', icon: 'trace', devOnly: true, load },
]);
