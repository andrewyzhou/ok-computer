import type { ReactNode } from 'react';
import type { IconName } from './routes';

// each icon is drawn with lines on a 24 by 24 grid in the color of the text. the record type makes the build fail
// when a name of IconName has no drawing.
const PATHS: Record<IconName, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  desk: <path d="M3 9h18M5 9v10M19 9v10M9 9v4h6V9M7 5h10l2 4H5z" />,
  inbox: (
    <>
      <path d="M4 13h4l1.5 2.5h5L16 13h4" />
      <path d="M6.5 5h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  docs: (
    <>
      <path d="M6.5 3.5h7l4 4V20a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5z" />
      <path d="M13.5 3.5V7.5h4M9.5 12h5M9.5 15.5h5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M15.5 6a3 3 0 0 1 0 5.6M17 14.8c1.8.5 3 1.8 3.5 4.2" />
    </>
  ),
  chat: <path d="M5 5.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4.5 3.5V16.5H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />,
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  goal: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  memory: (
    <>
      <path d="M6 4.5h10.5a1.5 1.5 0 0 1 1.5 1.5v14H7.5A1.5 1.5 0 0 1 6 18.5z" />
      <path d="M6 17.5A1.5 1.5 0 0 1 7.5 16H18M10 8.5h4.5" />
    </>
  ),
  automation: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  signal: (
    <>
      <circle cx="12" cy="12" r="1.5" />
      <path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.5 18.5a9.2 9.2 0 0 1 0-13M18.5 5.5a9.2 9.2 0 0 1 0 13" />
    </>
  ),
  approval: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  google: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12h7.8M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16M4.3 9.5h15.4M4.3 14.5h15.4" />
    </>
  ),
  integration: (
    <>
      <path d="M9 4.5v4M15 4.5v4M7 8.5h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16.5v3" />
    </>
  ),
  browser: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17M6.5 7h.01M8.5 7h.01" />
    </>
  ),
  run: <path d="M8 5.5v13l10-6.5z" />,
  session: (
    <>
      <path d="M5 6.5h14M5 12h14M5 17.5h9" />
    </>
  ),
  policy: (
    <>
      <path d="M12 4v16M6 7h12M6 7l-3 6.5a3 3 0 0 0 6 0zM18 7l-3 6.5a3 3 0 0 0 6 0z" />
      <path d="M8.5 20h7" />
    </>
  ),
  cost: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.5 9.5c-.4-1-1.3-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.3 0-2.2-.6-2.6-1.6M12 6.5V8M12 16v1.5" />
    </>
  ),
  log: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </>
  ),
  trace: (
    <>
      <path d="M4 6h9M7 10.5h9M10 15h10M6 19.5h6" />
    </>
  ),
  sandbox: (
    <>
      <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z" />
      <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4 6.5 8 6 8-6" />
    </>
  ),
  subscription: (
    <>
      <path d="M4.5 9a8 8 0 0 1 14.2-2.5M19.5 15a8 8 0 0 1-14.2 2.5" />
      <path d="M19 3.5v3.5h-3.5M5 20.5V17h3.5" />
    </>
  ),
  draft: (
    <>
      <path d="M14.5 5.5 18.5 9.5 9 19H5v-4z" />
      <path d="M12.5 7.5l4 4" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="7.5" width="14" height="11" rx="3" />
      <path d="M12 4v3.5M9.5 12.5h.01M14.5 12.5h.01M9.5 15.5h5" />
    </>
  ),
  connection: (
    <>
      <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  dev: <path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 5l-3 14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  'chevron-left': <path d="m14.5 6-6 6 6 6" />,
  'chevron-right': <path d="m9.5 6 6 6-6 6" />,
  'chevron-down': <path d="m6 9.5 6 6 6-6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
    </>
  ),
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  monitor: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  sort: <path d="M7 4.5v15M7 19.5l-3-3M7 19.5l3-3M17 19.5v-15M17 4.5l-3 3M17 4.5l3 3" />,
  display: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v3.5H16" />
    </>
  ),
  command: (
    <path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9z" />
  ),
};

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

// an icon next to a text needs no label, so it is hidden from screen readers. an icon alone gets its label from the
// button or the link around it, or from label here.
export function Icon({ name, size = 18, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true, focusable: false })}
    >
      {PATHS[name]}
    </svg>
  );
}
