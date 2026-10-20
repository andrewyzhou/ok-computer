import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// one doc at #/docs/:id: the rendered markdown of a version, the version history with a diff, the links, the export
// and the owner's comments (DocComments of Comments.tsx). ?version=N picks a version. the reader package builds it.
export function DocPage(props: RouteProps) {
  void props;
  return (
    <Page title="Doc" crumbs={[{ label: 'Docs', href: '#/docs' }]}>
      <EmptyState icon="docs" title="The doc page is not built yet." />
    </Page>
  );
}
