import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';
import './desk.css';

// the desk: a board of the delegations with a column for each status, the filters by status and person, the details
// panel of the selected delegation and the create form. the work package "desk board" builds this page and Board.tsx;
// the work package "details panel and form" builds Details.tsx and DelegationForm.tsx, which this page renders.
export function DeskPage(_props: RouteProps) {
  return (
    <Page title="Desk" subtitle="What ok computer is handling for you, and who it waits on.">
      <EmptyState icon="desk" title="The desk is not built yet." />
    </Page>
  );
}
