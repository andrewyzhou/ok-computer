import { useRef, type KeyboardEvent } from 'react';

export interface TabItem<V extends string = string> {
  id: V;
  label: string;
  // a count after the label, for example the pending approvals. zero and the empty text show nothing. a text is for a
  // count the server does not know in full, for example 2+.
  count?: number | string;
}

// tabs that switch the view of one page. the arrow keys, Home and End move between the tabs, as in a tab list.
export function Tabs<V extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: Array<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(items[next]!.id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list}>
      {items.map((item, index) => {
        const on = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'tab is-on' : 'tab'}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => keys(event, index)}
          >
            {item.label}
            {item.count !== undefined && item.count !== 0 && item.count !== '' ? <span className="count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
