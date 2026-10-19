import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../icons';
import type { IconName } from '../routes';

// primary is the black pill for the one main action of a view. secondary is the outlined pill, ghost has no border,
// and danger is for an action that removes or refuses something.
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

function classes(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  return ['btn', `btn-${variant}`, `btn-${size}`, extra].filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  // busy disables the button while its request runs, and tells a screen reader.
  busy?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon, busy, className, type = 'button', disabled, children, ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={classes(variant, size, className)} disabled={disabled || busy} aria-busy={busy || undefined}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
}

// a link that looks like a button, for an action that opens a page or a file.
export function ButtonLink({ variant = 'secondary', size = 'md', icon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a {...rest} className={classes(variant, size, className)}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </a>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  // the label is the accessible name and the tooltip, because the button shows no text.
  label: string;
  size?: ButtonSize;
}

export function IconButton({ icon, label, size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} aria-label={label} title={label} className={['icon-btn', `icon-btn-${size}`, className].filter(Boolean).join(' ')}>
      <Icon name={icon} size={size === 'sm' ? 15 : 18} />
    </button>
  );
}

export interface PillProps {
  children: ReactNode;
  icon?: IconName;
  // a pill with onClick is a toggle button, and pressed gives its state.
  onClick?: () => void;
  pressed?: boolean;
  title?: string;
  className?: string;
}

// a small rounded tag, for example a tool chip in a chat or an active filter.
export function Pill({ children, icon, onClick, pressed, title, className }: PillProps) {
  const inner = (
    <>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </>
  );
  const name = ['pill', className].filter(Boolean).join(' ');
  if (!onClick)
    return (
      <span className={name} title={title}>
        {inner}
      </span>
    );
  return (
    <button type="button" className={`${name} pill-button`} aria-pressed={pressed} title={title} onClick={onClick}>
      {inner}
    </button>
  );
}
