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

// the tone of each status word of the api. a word that is not here is muted.
const STATUS_TONE: Record<string, Tone> = {
  completed: 'good',
  approved: 'good',
  done: 'good',
  running: 'info',
  on: 'good',
  off: 'muted',
  open: 'info',
  pending: 'warning',
  skipped: 'muted',
  expired: 'muted',
  dropped: 'muted',
  aborted: 'serious',
  denied: 'serious',
  failed: 'critical',
  error: 'critical',
  warn: 'warning',
  allow: 'good',
  review: 'warning',
  approve: 'warning',
  deny: 'critical',
  hold: 'serious',
  tainted: 'serious',
  ran: 'good',
  invalid: 'critical',
  held: 'serious',
  waiting: 'warning',
  declined: 'serious',
  abandoned: 'serious',
  late: 'warning',
  interrupted: 'serious',
  unsent: 'warning',
  connected: 'good',
  connecting: 'info',
  needs_auth: 'warning',
  paused: 'muted',
  ready: 'good',
  stopped: 'muted',
  read: 'muted',
  write: 'warning',
  external: 'serious',
  ok: 'good',
  signed_out: 'warning',
  notified: 'good',
  seen: 'muted',
  filtered: 'muted',
  stale: 'muted',
};

export function toneOf(status: string): Tone {
  return STATUS_TONE[status] ?? 'muted';
}

// a status always shows its word, so the color is never the only signal.
export function Status({ value }: { value: string }) {
  return <Badge tone={toneOf(value)}>{value}</Badge>;
}
