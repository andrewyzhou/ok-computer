import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the list of the docs at #/docs, with a kind filter and a search. the list package builds it.
export function DocsListPage(props: RouteProps) {
  void props;
  return (
    <Page title="Docs">
      <EmptyState icon="docs" title="The docs list is not built yet." />
    </Page>
  );
}
