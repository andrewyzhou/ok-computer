import type { ReactNode, Ref } from 'react';
import { Icon } from '../icons';
import type { IconName } from '../routes';

// the bar under the page title: tabs on the left, then the filters, and the sort and display choices at the end.
// it stays at the top of the main area while the page scrolls.
export function FilterBar({ children, end, label = 'filters' }: { children?: ReactNode; end?: ReactNode; label?: string }) {
  return (
    <div className="filterbar" role="toolbar" aria-label={label}>
      <div className="filterbar-main">{children}</div>
      {end ? <div className="filterbar-end">{end}</div> : null}
    </div>
  );
}

export type Option = string | { value: string; label: string };

const optionValue = (option: Option) => (typeof option === 'string' ? option : option.value);
const optionLabel = (option: Option) => (typeof option === 'string' ? option : option.label);

// a select with its label as the accessible name. allLabel adds a first option with the empty value.
export function Select({
  label,
  value,
  options,
  onChange,
  allLabel,
  icon,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  allLabel?: string;
  icon?: IconName;
}) {
  return (
    <label className={`select${value ? ' is-set' : ''}`}>
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className="select-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
        {options.map((option) => (
          <option key={optionValue(option)} value={optionValue(option)}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className="search-field">
      <Icon name="search" size={15} />
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

// a choice of a few values that shows all of them, for example the density of a list.
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: Array<{ value: V; label: string; icon?: IconName }>;
  onChange: (value: V) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={option.value === value ? 'is-on' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={14} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}
