import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  // end aligns a number to the right with tabular digits.
  align?: 'start' | 'end';
  // wrap lets a long text break. without it the cell keeps one line where it can.
  wrap?: boolean;
  // the column is hidden on a screen narrower than 760px (sm) or 1100px (md), so a phone shows the main columns.
  hideBelow?: 'sm' | 'md';
  width?: string;
}

export interface TableProps<T> {
  // the accessible name of the table.
  label: string;
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  // with onSelect a row is a target: a click, Enter or Space selects it, and the arrow keys move between the rows. the
  // selected row has aria-current, because a row of a plain table cannot be aria-selected, and a screen reader then
  // says nothing.
  onSelect?: (row: T) => void;
  selected?: string | null;
  // dense is for the developer views. the other views keep the default spacing.
  dense?: boolean;
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
}

function cellClass(column: Column<unknown>): string | undefined {
  const names = [column.align === 'end' ? 'num' : '', column.wrap ? 'wrap' : '', column.hideBelow ? `hide-below-${column.hideBelow}` : '']
    .filter(Boolean)
    .join(' ');
  return names || undefined;
}

// a click on a link or a button in a row does its own work and does not select the row.
function fromControl(event: MouseEvent | KeyboardEvent): boolean {
  return Boolean((event.target as HTMLElement).closest('a, button, input, select, textarea, label'));
}

export function Table<T>({ label, columns, rows, rowKey, onSelect, selected, dense, empty, rowClassName }: TableProps<T>) {
  if (!rows.length && empty !== undefined) return <>{empty}</>;
  const move = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (fromControl(event)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(row);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
      (next as HTMLElement | null)?.focus();
    }
  };
  return (
    <div className="table-wrap">
      <table className={['table', dense ? 'table-dense' : '', onSelect ? 'table-select' : ''].filter(Boolean).join(' ')} aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cellClass(column as Column<unknown>)} style={column.width ? { width: column.width } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const isSelected = selected === key;
            return (
              <tr
                key={key}
                className={[isSelected ? 'is-selected' : '', rowClassName?.(row) ?? ''].filter(Boolean).join(' ') || undefined}
                {...(onSelect
                  ? {
                      tabIndex: 0,
                      ...(isSelected ? { 'aria-current': 'true' as const } : {}),
                      onClick: (event: MouseEvent<HTMLTableRowElement>) => !fromControl(event) && onSelect(row),
                      onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => move(event, row),
                    }
                  : {})}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cellClass(column as Column<unknown>)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
