import type { RouteProps } from '../../routes';
import { EmptyState, Page } from '../../ui';

// the Settings → Sign-in page. it reads GET /api/sign-in/sessions (src/dashboard/signin-types.ts) and lists each
// session, with sign-out of one and of all. this is the stub until the page is built.
export function SignInPage(_props: RouteProps) {
  return (
    <Page title="Sign-in">
      <EmptyState title="Not built yet" />
    </Page>
  );
}
