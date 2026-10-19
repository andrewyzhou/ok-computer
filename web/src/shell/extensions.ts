import type { ComponentType } from 'react';
import type { IconName, NavGroup } from '../routes';

// a view folder can add parts to the shell without an edit to a shared file. it puts the default export of
// web/src/views/<area>/shell.ts (or shell.tsx) through defineShellExtension, and the shell finds it like routes.ts.

export interface NavPanelProps {
  // the text of the search field at the top of the nav.
  filter: string;
  devMode: boolean;
  // the panel calls it after a click on a link, so the nav sheet of a phone closes.
  onNavigate(): void;
}

// a text with the [start, end) offsets of its matches, so the menu marks them without html from the server.
export interface Marked {
  text: string;
  marks: Array<[number, number]>;
}

export interface CommandItem {
  id: string;
  label: string;
  detail?: string | Marked;
  icon?: IconName;
  // the hash route without #/, for example runs/run-1. an item has href or run.
  href?: string;
  run?: () => void;
  // more words that the local filter of the menu matches.
  keywords?: string;
}

export interface CommandGroup {
  id: string;
  label: string;
  items: CommandItem[];
  // a link to the full list, for example the search page. href is a hash route without #/.
  more?: { label: string; href: string };
}

// a source answers the text of the command menu. the menu waits 150 ms after the last key, aborts the request of an
// older text, and shows the groups after the local items. a source that fails shows its error in its place.
export interface CommandSource {
  id: string;
  label: string;
  // the shortest text that the source answers. the default is 1.
  minQuery?: number;
  search(query: string, signal: AbortSignal): Promise<CommandGroup[]>;
}

export interface ShellExtension {
  // a panel under the items of a nav group, for example the list of chats.
  navPanels?: Array<{ group: NavGroup; Component: ComponentType<NavPanelProps> }>;
  // fixed actions of the command menu, filtered by the text like the pages.
  commands?: CommandItem[];
  commandSources?: CommandSource[];
}

export function defineShellExtension(extension: ShellExtension): ShellExtension {
  return extension;
}

const modules = import.meta.glob<{ default: ShellExtension }>(['../views/*/shell.ts', '../views/*/shell.tsx'], { eager: true });

export const EXTENSIONS: ShellExtension[] = Object.keys(modules)
  .sort()
  .map((file) => modules[file]!.default);
