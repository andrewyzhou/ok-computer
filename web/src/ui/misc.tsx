import { useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import type { IconName } from '../routes';
import { bytes } from '../format';
import { IconButton } from './Button';

// a list or a panel with nothing to show says why, and what the owner can do.
export function EmptyState({ icon, title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <Icon name={icon} size={22} /> : null}
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function isMac(): boolean {
  return /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? '');
}

// the command key on a mac and the control key on other systems. a mac takes only the command key, because control
// with a letter is an editing key in its text fields, for example Ctrl+K deletes to the end of the line. the other
// systems take both.
export function hasMod(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.metaKey || event.ctrlKey;
}

const KEY_TEXT: Record<string, () => string> = {
  mod: () => (isMac() ? '⌘' : 'Ctrl'),
  shift: () => (isMac() ? '⇧' : 'Shift'),
  enter: () => '↵',
  esc: () => 'Esc',
  up: () => '↑',
  down: () => '↓',
};

// a keyboard shortcut, for example keys={['mod', 'K']}.
export function KeyHint({ keys, label }: { keys: string[]; label?: string }) {
  return (
    <span className="keyhint" aria-label={label}>
      {keys.map((key) => (
        <kbd key={key}>{KEY_TEXT[key]?.() ?? key}</kbd>
      ))}
    </span>
  );
}

// grey bars in the shape of the content that loads. a screen reader hears the text Loading.
export function Skeleton({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

// a text exactly as it is stored, with its size and a copy button. it is for the request and response bodies of the
// developer views, so it never changes the text.
export function CodeBlock({ text, label, maxHeight = 480 }: { text: string; label?: string; maxHeight?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void globalThis.navigator?.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  return (
    <figure className="code-block">
      <figcaption className="code-head">
        <span>{label}</span>
        <span className="code-size">{bytes(new TextEncoder().encode(text).length)}</span>
        <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy'} size="sm" onClick={copy} />
      </figcaption>
      <pre style={{ maxHeight }}>{text}</pre>
    </figure>
  );
}

// a text with marks from the server. the marks are [start, end) offsets, and the text never renders as html.
export function Highlight({ text, marks }: { text: string; marks: Array<[number, number]> }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of [...marks].sort((a, b) => a[0] - b[0])) {
    if (start < at || end <= start) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
