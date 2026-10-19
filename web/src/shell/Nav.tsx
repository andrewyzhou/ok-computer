import type { Ref } from 'react';
import { Icon } from '../icons';
import type { NavSection, RouteDef } from '../routes';
import { SearchField } from '../ui';
import { EXTENSIONS } from './extensions';
import { GROUP_ICONS, routeHref } from './model';

// the rail has one icon for each nav group. it opens the first page of the group.
export function Rail({ sections, current, onSearch }: { sections: NavSection[]; current: RouteDef | undefined; onSearch: () => void }) {
  return (
    <div className="rail">
      <a className="rail-brand" href="#/" aria-label="ok computer, overview">
        ok
      </a>
      <ul className="rail-list">
        {sections.map((section) => {
          const active = current?.group === section.group;
          return (
            <li key={section.group}>
              <a
                className={active ? 'rail-item is-on' : 'rail-item'}
                href={routeHref(section.items[0]!)}
                aria-label={section.label}
                title={section.label}
                aria-current={active ? 'true' : undefined}
              >
                <Icon name={GROUP_ICONS[section.group]} size={19} />
              </a>
            </li>
          );
        })}
      </ul>
      <div className="rail-end">
        <button type="button" className="rail-item" aria-label="Search and commands" title="Search and commands" onClick={onSearch}>
          <Icon name="search" size={19} />
        </button>
      </div>
    </div>
  );
}

const PANELS = EXTENSIONS.flatMap((extension) => extension.navPanels ?? []);

export function Nav({
  sections,
  current,
  filter,
  onFilter,
  devMode,
  onNavigate,
  searchRef,
  panels = PANELS,
}: {
  sections: NavSection[];
  current: RouteDef | undefined;
  filter: string;
  onFilter: (value: string) => void;
  devMode: boolean;
  onNavigate: () => void;
  searchRef: Ref<HTMLInputElement>;
  // the panels of the view folders. a test gives its own.
  panels?: typeof PANELS;
}) {
  const needle = filter.trim().toLowerCase();
  const hasChats = panels.some((panel) => panel.group === 'chats');
  const shown = sections
    .map((section) => ({
      section,
      items: needle ? section.items.filter((item) => item.label.toLowerCase().includes(needle)) : section.items,
      panels: panels.filter((panel) => panel.group === section.group),
    }))
    .filter((each) => each.items.length || each.panels.length);
  return (
    <div className="sidenav-inner">
      <div className="nav-brand">
        <a href="#/" className="wordmark" onClick={onNavigate}>
          ok computer
        </a>
      </div>
      <div className="nav-search">
        <SearchField
          label={hasChats ? 'Search chats and pages' : 'Filter pages'}
          placeholder={hasChats ? 'Search chats' : 'Filter pages'}
          value={filter}
          onChange={onFilter}
          inputRef={searchRef}
        />
      </div>
      <div className="nav-groups">
        {shown.map(({ section, items, panels }) => (
          <section key={section.group} className="nav-group" aria-labelledby={`nav-${section.group}`}>
            <h2 className="nav-group-label" id={`nav-${section.group}`}>
              {section.label}
            </h2>
            {items.length ? (
              <ul className="nav-list">
                {items.map((item) => {
                  const active = current === item;
                  return (
                    <li key={item.path}>
                      <a
                        className={active ? 'nav-item is-on' : 'nav-item'}
                        href={routeHref(item)}
                        aria-current={active ? 'page' : undefined}
                        onClick={onNavigate}
                      >
                        <Icon name={item.icon} size={16} />
                        <span className="nav-label">{item.label}</span>
                        {item.devOnly ? <span className="nav-tag">dev</span> : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {panels.map((panel, index) => (
              <panel.Component key={index} filter={filter} devMode={devMode} onNavigate={onNavigate} />
            ))}
          </section>
        ))}
        {!shown.length ? <p className="nav-none">No page matches “{filter}”.</p> : null}
      </div>
    </div>
  );
}
