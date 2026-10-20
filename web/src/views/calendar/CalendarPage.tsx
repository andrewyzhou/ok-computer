import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the calendar page: the week or the day of query.day, colored by calendar, with the selected event in the details
// panel and the pending proposals as dashed blocks. the work package "calendar view" builds it.
export function CalendarPage(_props: RouteProps) {
  return (
    <Page title="Calendar">
      <EmptyState icon="calendar" title="The calendar page is not built yet." />
    </Page>
  );
}
