import { defineRoutes } from '../../routes';

// the calendar page of phase 6 t1: a week and a day grid of every calendar that the owner shows. the query holds the
// day, the mode (week or day) and the selected event, as calendarHash in ../today/links.ts writes it.
export default defineRoutes([
  { path: 'calendar', group: 'calendar', label: 'Calendar', icon: 'calendar', order: 10, load: () => import('./CalendarPage').then((m) => m.CalendarPage) },
]);
