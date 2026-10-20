import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the people list and the profile of params.id in the details panel. the views work package builds it; until then
// the page says that it is not there yet.
export function PeoplePage(props: RouteProps) {
  void props;
  return (
    <Page title="People">
      <EmptyState icon="people" title="People is not built yet" />
    </Page>
  );
}
