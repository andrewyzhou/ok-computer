import { useState, type ReactNode } from 'react';
import type { Loaded } from './api';
import { Page as UiPage, Section, Skeleton } from './ui';

// Status lives in web/src/ui/Badge.tsx. this file gives it to the pages from before phase 5.
export { Status } from './ui';

// Page and Panel are the parts of the pages from before phase 5. they now use the shared parts in web/src/ui, so each
// old page sits in the shell until its restyle.
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <UiPage title={title} actions={actions}>
      {children}
    </UiPage>
  );
}

export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Section title={title} actions={actions}>
      {children}
    </Section>
  );
}

export function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note ? <div className="tile-note">{note}</div> : null}
    </div>
  );
}

// the pages render only after their data loaded. an error shows in the place of the page.
export function Load<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => ReactNode }) {
  if (loaded.error) return <p className="error-box">Could not load: {loaded.error}</p>;
  if (loaded.data === undefined) return <Skeleton lines={4} />;
  return <>{children(loaded.data)}</>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function Expand({ label, children }: { label: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="expand">
      <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open ? children() : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

export interface Bar {
  label: string;
  value: number;
  title: string;
}

// one series only, so the chart needs no legend. the panel title names the series. each bar has a native tooltip,
// and the hit area is the full column, not only the bar.
export function BarChart({ bars, max, format }: { bars: Bar[]; max?: number; format: (value: number) => string }) {
  const top = Math.max(max ?? 0, ...bars.map((bar) => bar.value), Number.EPSILON);
  const width = 640;
  const height = 160;
  const pad = { top: 16, bottom: 22, left: 44 };
  const slot = (width - pad.left) / Math.max(bars.length, 1);
  const barWidth = Math.min(24, Math.max(2, slot - 2));
  const plot = height - pad.top - pad.bottom;
  const y = (value: number) => pad.top + plot - (value / top) * plot;
  const labelEvery = Math.ceil(bars.length / 8);
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="bar chart">
      {[0, 0.5, 1].map((share) => (
        <g key={share}>
          <line className="grid" x1={pad.left} x2={width} y1={y(top * share)} y2={y(top * share)} />
          <text className="axis" x={pad.left - 6} y={y(top * share) + 4} textAnchor="end">
            {format(top * share)}
          </text>
        </g>
      ))}
      {bars.map((bar, i) => {
        const x = pad.left + i * slot + (slot - barWidth) / 2;
        const h = Math.max(0, y(0) - y(bar.value));
        const r = Math.min(4, h / 2, barWidth / 2);
        return (
          <g key={bar.label} className="bar-hit">
            <title>{bar.title}</title>
            <rect x={pad.left + i * slot} y={pad.top} width={slot} height={plot} fill="transparent" />
            {h > 0 ? (
              <path
                className="bar"
                d={`M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barWidth - r} Q${x + barWidth},${y(0) - h} ${x + barWidth},${y(0) - h + r} V${y(0)} Z`}
              />
            ) : null}
            {i % labelEvery === 0 ? (
              <text className="axis" x={x + barWidth / 2} y={height - 6} textAnchor="middle">
                {bar.label}
              </text>
            ) : null}
          </g>
        );
      })}
      <line className="baseline" x1={pad.left} x2={width} y1={y(0)} y2={y(0)} />
    </svg>
  );
}
