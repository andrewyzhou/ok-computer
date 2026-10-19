import { useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShell, type Crumb } from '../shell/context';

export interface PageProps {
  title: string;
  // a short line under the title, for example the day or the state of the page.
  subtitle?: ReactNode;
  // the actions go to the right of the shell header. outside the shell they go next to the title.
  actions?: ReactNode;
  // the crumbs between the nav group and the title. a detail page gives its list here, for example Runs.
  crumbs?: Crumb[];
  // the FilterBar of the page. it stays at the top of the main area while the page scrolls.
  toolbar?: ReactNode;
  // full gives the page the whole width of the main area, for a dense table or a waterfall.
  width?: 'normal' | 'full';
  children: ReactNode;
}

export function Page({ title, subtitle, actions, crumbs, toolbar, width = 'normal', children }: PageProps) {
  const shell = useShell();
  const crumbKey = JSON.stringify(crumbs ?? null);
  useLayoutEffect(() => {
    shell?.setPage({ title, ...(crumbs ? { crumbs } : {}) });
    // the crumbs are compared by their text, so a new array with the same crumbs changes nothing.
  }, [shell, title, crumbKey]);
  useLayoutEffect(() => () => shell?.setPage(null), [shell]);
  const inShell = Boolean(shell?.headerActions);
  return (
    <article className={`page page-${width}`}>
      <header className="page-head">
        <div className="page-titles">
          <h1 className="page-title">{title}</h1>
          {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
        </div>
        {actions && !inShell ? <div className="page-actions">{actions}</div> : null}
      </header>
      {actions && inShell ? createPortal(<div className="header-actions">{actions}</div>, shell!.headerActions!) : null}
      {toolbar}
      <div className="page-body">{children}</div>
    </article>
  );
}

// a part of a page under a hairline rule, with a small title. it has no box.
export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="section" id={id}>
      <header className="section-head">
        <div>
          <h2 className="section-title">{title}</h2>
          {description ? <p className="section-description">{description}</p> : null}
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

// a row of large numbers with their labels, divided by hairlines.
export function Stats({ children, label = 'summary' }: { children: ReactNode; label?: string }) {
  return (
    <dl className="stats" aria-label={label}>
      {children}
    </dl>
  );
}

export function Stat({ label, value, note }: { label: ReactNode; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
      {note ? <dd className="stat-note">{note}</dd> : null}
    </div>
  );
}

export interface Fact {
  label: ReactNode;
  value: ReactNode;
}

// label and value pairs, for example the facts of a run in the details panel. a false entry is left out.
export function Facts({ items, layout = 'columns' }: { items: Array<Fact | false | null | undefined>; layout?: 'columns' | 'stacked' }) {
  return (
    <dl className={`facts-list facts-${layout}`}>
      {items.filter((item): item is Fact => Boolean(item)).map((item, index) => (
        <div key={index} className="fact">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
