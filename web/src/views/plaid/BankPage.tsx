import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the bank page: the setup steps without credentials, else each linked bank with its accounts, status and last sync,
// and its recurring charges with their price history. connect and reconnect open plaid link (./link.ts). the work
// package "bank page" builds it.
export function BankPage(_props: RouteProps) {
  return (
    <Page title="Bank">
      <EmptyState icon="cost" title="The bank page is not built yet." />
    </Page>
  );
}
