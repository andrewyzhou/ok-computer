import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the connections page: a grid of cards with a status dot, Connect / Disconnect / Reconnect, the last error in full and
// a switch for each tool, and a details panel with the account and its activity. it reads GET /api/connections.
export function ConnectionsPage(_props: RouteProps) {
  return (
    <Page title="Connections">
      <EmptyState icon="connection" title="Connections are on the way." />
    </Page>
  );
}
