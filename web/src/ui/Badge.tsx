import type { ReactNode } from 'react';

// the tones of a status. a badge always shows its word next to the dot, so the color is never the only signal.
export type Tone = 'good' | 'info' | 'warning' | 'serious' | 'critical' | 'muted';

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

// a count next to a tab or a nav item. zero shows nothing.
export function Count({ value, label }: { value: number; label?: string }) {
  if (!value) return null;
  return (
    <span className="count" aria-label={label ? `${value} ${label}` : undefined}>
      {value}
    </span>
  );
}
