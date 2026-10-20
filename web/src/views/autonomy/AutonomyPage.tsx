import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the page is a placeholder until the view of track T6 is built. it reads GET /api/autonomy and changes a level with
// POST /api/autonomy/:domain (src/dashboard/autonomy-types.ts).
export function AutonomyPage(_props: RouteProps) {
  return (
    <Page title="Autonomy">
      <EmptyState icon="policy" title="Not built yet" />
    </Page>
  );
}
