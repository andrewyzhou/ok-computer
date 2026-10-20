import type { Hono } from 'hono';
import { peopleStore, type PeopleStore } from '../people/store.js';
import type { DashboardDeps } from './server.js';

// phase 6 t5 owns this module. it mounts the /api/people routes, and src/dashboard/people-types.ts gives their shapes.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth, and a write without a json
// body already got 415 there. the routes:
// - GET /api/people?q=&sort=&cursor=&limit= gives a PeoplePage.
// - GET /api/people/status gives the PeopleStatus.
// - GET /api/people/lookup?email= gives the PersonSummary of an address, for the person chip.
// - GET /api/people/:id gives a PersonProfile.
// - POST /api/people/:id/notes takes a PersonNoteInput and gives the new PersonNoteView, written by the owner.
// until the routes work package lands it mounts nothing, and each path answers the 404 of an unknown api route.
// store is the real store, and a test can give a fake.
export function mountPeople(server: Hono, deps: DashboardDeps, store: PeopleStore = peopleStore): void {
  void server;
  void deps;
  void store;
}
