import { useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Brief, BriefItem, BriefSchedule, BriefSection, BriefSource, BriefSources } from '../../../../src/dashboard/brief-types';
import { send } from '../../api';
import { clock, longDay } from '../../format';
import { Badge, Button, ButtonLink, DetailsPanel, Facts } from '../../ui';
import { calendarHash, sourceHash } from './links';

// the parts of the today page: the day math, the schedule line, the sections with their items, the details of an
// item, the strip of missing sources and the line of the delivery.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// a day is yyyy-mm-dd and a real date of the calendar, so 2026-02-30 is not a day.
export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// the day of an instant in a time zone, as yyyy-mm-dd.
export function localDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// the day that is a number of days after a day. the math is in utc, so a change of summer time moves no day.
export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

// a short day of an instant in a time zone, for example Tue 13 Oct.
export function shortDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
}

// the time of an item: a day alone for an all-day item, else the day and the clock, for example Mon 12 Oct, 07:00.
export function itemTime(at: string, timeZone: string): string {
  if (DAY.test(at)) return longDay(at);
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(at),
  );
}

const SOURCE_WORDS: Record<BriefSource['kind'], string> = {
  event: 'calendar event',
  thread: 'mail thread',
  digest: 'inbox digest',
  draft: 'draft reply',
  proposal: 'calendar proposal',
  delegation: 'delegation',
  goal: 'goal',
};

const TONE_WORDS = { warning: 'needs you', critical: 'urgent' } as const;

function ToneBadge({ tone }: { tone: BriefItem['tone'] }) {
  if (tone !== 'warning' && tone !== 'critical') return null;
  return <Badge tone={tone}>{TONE_WORDS[tone]}</Badge>;
}

// a click with a key that opens a new tab or window keeps the link. a plain click selects the item.
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

// one item of a section. the whole item is a link to its source, so it can open in a new tab, and a plain click or
// enter selects it and shows it in the details panel. the title and the detail can come from mail and invitations,
// so they render as text.
function Item({ item, selected, onSelect }: { item: BriefItem; selected: boolean; onSelect: () => void }) {
  const className = ['today-item', item.tone === 'warning' || item.tone === 'critical' ? `today-tone-${item.tone}` : '', selected ? 'is-selected' : '']
    .filter(Boolean)
    .join(' ');
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    onSelect();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onSelect();
  };
  return (
    <li>
      <a href={sourceHash(item.source)} className={className} aria-current={selected ? 'true' : undefined} onClick={onClick} onKeyDown={onKeyDown}>
        <span className="today-item-main">
          <span className="today-item-title">{item.title}</span>
          {item.detail ? <span className="today-item-detail">{item.detail}</span> : null}
        </span>
        {item.account || item.tone === 'warning' || item.tone === 'critical' ? (
          <span className="today-item-badges">
            <ToneBadge tone={item.tone} />
            {item.account ? <Badge tone="muted">{item.account}</Badge> : null}
          </span>
        ) : null}
      </a>
    </li>
  );
}

// a note that the sources strip already says is not drawn again under its section, and a section with no items and
// no other note is left out. the index of each section stays the same, so the keys of the items do not change.
export function BriefSections({
  sections,
  selectedId,
  onSelect,
  strip = [],
}: {
  sections: BriefSection[];
  selectedId: string | null;
  onSelect: (key: string) => void;
  strip?: string[];
}) {
  return (
    <>
      {sections.map((section, index) => {
        const note = section.note && !strip.includes(section.note) ? section.note : null;
        if (!note && !section.items.length) return null;
        return (
          <section key={`${section.kind}:${index}`} className="today-section" aria-labelledby={`today-section-${index}`}>
            <h2 className="today-section-title" id={`today-section-${index}`}>
              {section.title}
            </h2>
            {note ? <p className="today-section-note">{note}</p> : null}
            {section.items.length ? (
              <ul className="today-items" aria-label={section.title}>
                {section.items.map((item) => {
                  const key = itemKey(section, index, item);
                  return <Item key={key} item={item} selected={key === selectedId} onSelect={() => onSelect(key)} />;
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </>
  );
}

// an item id can show in two sections, for example an event of the day that is also an invitation, so the key of a
// selection holds the place of its section too.
export function itemKey(section: BriefSection, index: number, item: BriefItem): string {
  return `${index}:${section.kind}:${item.id}`;
}

export function findItem(sections: BriefSection[], key: string | null): BriefItem | undefined {
  if (key === null) return undefined;
  for (const [index, section] of sections.entries()) {
    const item = section.items.find((each) => itemKey(section, index, each) === key);
    if (item) return item;
  }
  return undefined;
}

export function ItemDetails({ item, timeZone, onClose }: { item: BriefItem | undefined; timeZone: string; onClose: () => void }) {
  if (!item)
    return (
      <DetailsPanel title="Details">
        <p className="muted">Select an item to see its details.</p>
      </DetailsPanel>
    );
  const source = item.source;
  return (
    <DetailsPanel title="Item" openKey={item.id} onClose={onClose}>
      <div className="today-details">
        <p className="today-details-title">{item.title}</p>
        {item.detail ? <p className="today-details-detail">{item.detail}</p> : null}
        <Facts
          layout="stacked"
          items={[
            item.at ? { label: 'Time', value: itemTime(item.at, timeZone) } : null,
            item.account ? { label: 'Account', value: item.account } : null,
            { label: 'Source', value: SOURCE_WORDS[source.kind] },
            item.tone === 'warning' || item.tone === 'critical' ? { label: 'State', value: <ToneBadge tone={item.tone} /> } : null,
          ]}
        />
        <div className="today-details-actions">
          <ButtonLink href={sourceHash(source)} size="sm" variant="primary">
            Open
          </ButtonLink>
          {source.kind === 'event' ? (
            <ButtonLink href={calendarHash(source.day, { mode: 'day' })} size="sm" icon="calendar">
              Day view
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </DetailsPanel>
  );
}

// the notes about the sources that the brief could not read. a missing desk module shows nothing, because the page
// does not claim that nothing waits.
export function sourceNotes(sources: BriefSources) {
  const notes: Array<{ key: string; text: string; link?: { href: string; label: string } }> = [];
  if (sources.calendar === 'off') notes.push({ key: 'off', text: 'Google is not set up, so the brief has no calendar.', link: { href: '#/google', label: 'Set up Google' } });
  else if (sources.calendar === 'partial' || sources.calendar === 'failed') {
    if (sources.skipped.length) for (const skipped of sources.skipped) notes.push({ key: `skip:${skipped.account}`, text: `The calendar of ${skipped.account} could not be read.` });
    else notes.push({ key: 'failed', text: 'The calendar could not be read.' });
  }
  if (sources.digest === null) notes.push({ key: 'digest', text: 'No inbox digest yet.', link: { href: '#/inbox', label: 'Open the inbox' } });
  return notes;
}

export function SourcesStrip({ sources }: { sources: BriefSources }) {
  const notes = sourceNotes(sources);
  if (!notes.length) return null;
  return (
    <ul className="today-sources" aria-label="missing sources">
      {notes.map((note) => (
        <li key={note.key}>
          <span>{note.text}</span>
          {note.link ? <a href={note.link.href}>{note.link.label}</a> : null}
        </li>
      ))}
    </ul>
  );
}

export function Delivery({ brief }: { brief: Brief }) {
  const delivery = brief.delivery;
  return (
    <section className="today-delivery" aria-label="delivery">
      <p className="today-delivery-line">
        {delivery === null ? (
          <span className="muted">Not sent yet.</span>
        ) : delivery.ok ? (
          <span>
            Sent to {delivery.channel ?? 'the owner'} at {clock(delivery.at)}
          </span>
        ) : (
          <span className="today-delivery-failed">Not sent: {delivery.error ?? 'the message did not go out'}</span>
        )}
      </p>
      <details className="today-message">
        <summary>Message</summary>
        <pre className="today-short">{brief.shortText}</pre>
      </details>
    </section>
  );
}

// the line of the automation, with a small form that moves it. a move also turns the brief on.
export function ScheduleLine({ schedule, error, timeZone, onSaved }: { schedule: BriefSchedule | undefined; error: string | undefined; timeZone: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  if (error) return <p className="today-schedule error-text">Could not load the schedule: {error}</p>;
  if (!schedule) return <p className="today-schedule muted">Loading the schedule…</p>;
  const open = () => {
    setValue(schedule.time ?? '07:30');
    setState({ busy: false });
    setEditing(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true });
    send<BriefSchedule>('/api/brief/schedule', 'PUT', { time: value }).then(
      () => {
        setState({ busy: false });
        setEditing(false);
        onSaved();
      },
      (err: Error) => setState({ busy: false, error: err.message }),
    );
  };
  const text = !schedule.enabled
    ? 'The brief is off'
    : schedule.time
      ? `Brief at ${schedule.time} each day${schedule.nextRunAt ? ` · next ${shortDate(schedule.nextRunAt, timeZone)}` : ''}`
      : 'The brief has no time each day';
  return (
    <div className="today-schedule">
      <span>{text}</span>
      {schedule.running ? <Badge tone="info">building</Badge> : null}
      {editing ? (
        <form className="today-schedule-form" onSubmit={save}>
          <input type="time" aria-label="Time of the brief" value={value} required onChange={(event) => setValue(event.target.value)} />
          <Button type="submit" size="sm" variant="primary" busy={state.busy}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <button type="button" className="link-button today-schedule-change" onClick={open}>
          {schedule.enabled ? 'Change' : 'Turn on'}
        </button>
      )}
      {state.error ? (
        <span role="alert" className="error-text today-schedule-error">
          {state.error}
        </span>
      ) : null}
    </div>
  );
}
