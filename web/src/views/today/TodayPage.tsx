import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the today page: the brief of a day (params.day, or today), with each item linked to its source. the work package
// "today view" builds it.
export function TodayPage(_props: RouteProps) {
  return (
    <Page title="Today">
      <EmptyState icon="today" title="The today page is not built yet." />
    </Page>
  );
}
