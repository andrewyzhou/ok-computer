import { createContext, useContext } from 'react';

// the shell gives the page parts a place in the frame: the header actions, the details panel and the title of the
// breadcrumb. a page outside the shell, for example in a test of one page, gets null and renders each part inline.

export interface Crumb {
  label: string;
  href?: string;
}

export interface PageInfo {
  title: string;
  // the crumbs between the nav group and the title. without them the shell uses the parent route of a detail page.
  crumbs?: Crumb[];
}

export interface ShellApi {
  headerActions: HTMLElement | null;
  details: HTMLElement | null;
  setPage(info: PageInfo | null): void;
  // a details panel registers while it is mounted, so the shell shows the column or the button of the drawer.
  registerDetails(): () => void;
  // on a narrow screen the details panel is a drawer. on a wide screen these change nothing.
  openDetails(): void;
  closeDetails(): void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi | null {
  return useContext(ShellContext);
}
