import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type {
  CalendarConflict,
  CalendarEvent,
  CalendarGuest,
  CalendarInfo,
  CalendarPage as CalendarData,
  CalendarProposalBlock,
  TravelGap,
} from '../../../../src/dashboard/calendar-types';
import { plural } from '../../format';
import { Badge, ButtonLink, Facts } from '../../ui';
import { ApprovalFor, useApprovals } from '../inbox/shared';
import { PersonChip } from '../people/PersonChip';
import {
  addDays,
  allDayRow,
  clockIn,
  dateOf,
  dayLabel,
  dayOf,
  foldDense,
  hourLabel,
  hourRange,
  layoutDay,
  safeColor,
  wallMinutes,
  weekdayOf,
  zonedMidnight,
  type AllDayBar,
  type DayBlock,
  type Span,
} from './grid';

// the parts of the calendar page: the items that the grid and the agenda draw, the legend, the week and day grid, the
// agenda of a narrow screen and the details of the selected item. event text comes from the person who sent the
// invitation, so every field shows as text and never as html.

// an item of the page: an event of a calendar, or a calendar event that the digest proposed. one invitation on two
// calendars (the same uid and start) is one item: event is the first copy, and copies holds the others with their
// colors, so the grid draws one block and the details name each calendar.
export type Item =
  | (Span & { kind: 'event'; title: string; color: string; event: CalendarEvent; copies: Array<{ event: CalendarEvent; color: string }> })
  | (Span & { kind: 'proposal'; title: string; color: string; proposal: CalendarProposalBlock });

// true when the item is the one that key names: its own key, or the key of one of its copies, which a brief item or
// an old link can hold.
export function itemIs(item: Item, key: string | null): boolean {
  if (key === null) return false;
  return item.key === key || (item.kind === 'event' && item.copies.some((copy) => copy.event.key === key));
}

export const proposalKey = (proposal: CalendarProposalBlock) => `proposal:${proposal.proposalId}`;

const HALF_HOUR_MS = 30 * 60_000;

// a proposal has no calendar yet. an all-day one covers the day of its start, and a timed one without an end lasts
// half an hour.
function proposalItem(proposal: CalendarProposalBlock, timeZone: string): Item {
  const base = { kind: 'proposal' as const, key: proposalKey(proposal), title: proposal.title, color: '#8a857c', proposal };
  if (proposal.allDay) {
    const day = proposal.startAt.slice(0, 10);
    return {
      ...base,
      allDay: true,
      startDay: day,
      endDay: day,
      startAt: new Date(zonedMidnight(day, timeZone)).toISOString(),
      endAt: new Date(zonedMidnight(addDays(day, 1), timeZone)).toISOString(),
    };
  }
  const start = Date.parse(proposal.startAt);
  const end = proposal.endAt ? Math.max(Date.parse(proposal.endAt), start) : start + HALF_HOUR_MS;
  return {
    ...base,
    allDay: false,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    startDay: dayOf(start, timeZone),
    endDay: dayOf(Math.max(start, end - 1), timeZone),
  };
}

// the items that the page draws: the events of the calendars that are not hidden, without the cancelled ones, and
// every proposal. copies of one invitation on two accounts join the item of the first copy.
export function itemsOf(page: CalendarData, hidden: ReadonlySet<string>): Item[] {
  const colors = new Map(page.calendars.map((each) => [each.key, safeColor(each.color)]));
  const colorOf = (event: CalendarEvent) => colors.get(event.calendarKey) ?? safeColor(null);
  const byCopy = new Map<string, Extract<Item, { kind: 'event' }>>();
  const events: Item[] = [];
  for (const event of page.events) {
    if (event.status === 'cancelled' || hidden.has(event.calendarKey)) continue;
    const copyKey = event.uid === null ? null : `${event.uid}@${Date.parse(event.startAt)}`;
    const first = copyKey === null ? undefined : byCopy.get(copyKey);
    if (first) {
      first.copies.push({ event, color: colorOf(event) });
      continue;
    }
    const item: Extract<Item, { kind: 'event' }> = { ...event, kind: 'event', title: event.title, color: colorOf(event), event, copies: [] };
    if (copyKey !== null) byCopy.set(copyKey, item);
    events.push(item);
  }
  return [...events, ...page.proposals.map((each) => proposalItem(each, page.timeZone))];
}

// the marks of the page: the conflicts and the travel gaps of each event key, and the keys of the invitations.
export interface Marks {
  conflicts: Map<string, CalendarConflict[]>;
  travelTo: Map<string, TravelGap>;
  travelFrom: Map<string, TravelGap>;
  invites: Set<string>;
  titles: Map<string, string>;
}

export function marksOf(page: CalendarData): Marks {
  const conflicts = new Map<string, CalendarConflict[]>();
  for (const conflict of page.conflicts) {
    for (const key of [conflict.a, conflict.b]) conflicts.set(key, [...(conflicts.get(key) ?? []), conflict]);
  }
  return {
    conflicts,
    travelTo: new Map(page.travelGaps.map((gap) => [gap.to, gap])),
    travelFrom: new Map(page.travelGaps.map((gap) => [gap.from, gap])),
    invites: new Set(page.invites),
    titles: new Map(page.events.map((each) => [each.key, each.title])),
  };
}

// the width where the shell folds the nav into a sheet. below it the page shows the agenda instead of the grid. the
// test is the same as the one of the shell, and it follows a resize.
export const AGENDA_BELOW = 760;

// a day column of the week grid narrower than this cannot show a title, for example when the details panel takes room
// from the page, so the page shows the agenda instead.
export const MIN_DAY_PX = 100;

// the width of an element, which follows a resize of the page and of the details panel. it is undefined until the
// first measure, and where the browser cannot measure, so a test sees the grid.
export function useWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function useNarrow(width = AGENDA_BELOW): boolean {
  const query = `(max-width: ${width - 0.02}px)`;
  return useSyncExternalStore(
    (listener) => {
      if (typeof globalThis.matchMedia !== 'function') return () => {};
      const list = globalThis.matchMedia(query);
      list.addEventListener?.('change', listener);
      return () => list.removeEventListener?.('change', listener);
    },
    () => typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(query).matches,
    () => false,
  );
}

// the calendars that the owner hid in the legend. they are a preference of this browser, so they live in
// localStorage. storage can be missing or throw, for example in a private window, and then the page still works and
// keeps the choice until it reloads.
export const HIDDEN_KEY = 'okc.calendar.hidden';

function readHidden(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(HIDDEN_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []);
  } catch {
    return new Set();
  }
}

export function useHidden(): [ReadonlySet<string>, (key: string) => void] {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(readHidden);
  const toggle = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHidden(next);
    try {
      globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    } catch {
      // the choice stays for this visit only.
    }
  };
  return [hidden, toggle];
}

const colorStyle = (color: string) => ({ '--cal': color }) as CSSProperties;

export function Dot({ color }: { color: string }) {
  return <span className="cal-dot" style={colorStyle(color)} aria-hidden="true" />;
}

export function Legend({ calendars, hidden, onToggle }: { calendars: CalendarInfo[]; hidden: ReadonlySet<string>; onToggle: (key: string) => void }) {
  if (!calendars.length) return null;
  return (
    <div className="cal-legend" role="group" aria-label="calendars">
      {calendars.map((calendar) => {
        const shown = !hidden.has(calendar.key);
        return (
          <button
            key={calendar.key}
            type="button"
            className={shown ? 'cal-chip' : 'cal-chip is-hidden'}
            aria-pressed={shown}
            title={`${shown ? 'Hide' : 'Show'} ${calendar.label}${calendar.account !== calendar.label ? ` (${calendar.account})` : ''}`}
            style={colorStyle(safeColor(calendar.color))}
            onClick={() => onToggle(calendar.key)}
          >
            <span className="cal-chip-dot" aria-hidden="true" />
            <span className="cal-chip-label">{calendar.label}</span>
            {calendar.account !== calendar.label ? <span className="cal-chip-account">{calendar.account}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// the key of the marks of the grid, so the owner can read the dot, the hatch, the dashed outline and the struck title
// without a hover. the agenda says the same in words on each row.
export function MarksKey() {
  return (
    <ul className="cal-key" aria-label="marks">
      <li>
        <span className="cal-key-conflict" aria-hidden="true" />
        Conflict
      </li>
      <li>
        <span className="cal-key-travel" aria-hidden="true" />
        Tight move
      </li>
      <li>
        <span className="cal-key-swatch is-tentative" aria-hidden="true" />
        Not answered or maybe
      </li>
      <li>
        <span className="cal-key-swatch is-proposal" aria-hidden="true" />
        Proposed, waits for you
      </li>
      <li>
        <span className="cal-key-declined">Declined</span>
      </li>
    </ul>
  );
}

// the time of an item in its time zone: all day, or the clock of its start and end, with the days when it ends on
// another day.
export function whenOf(item: Item, timeZone: string, withDay = true): string {
  if (item.allDay) {
    const range = item.endDay > item.startDay ? `${dayLabel(item.startDay)} to ${dayLabel(item.endDay)}` : dayLabel(item.startDay);
    return `${range}, all day`;
  }
  const start = Date.parse(item.startAt);
  const end = Date.parse(item.endAt);
  const startDay = dayOf(start, timeZone);
  // an event that ends at midnight ends on the day that it started.
  const endDay = dayOf(end > start ? end - 1 : end, timeZone);
  const times = `${clockIn(start, timeZone)} to ${clockIn(end, timeZone)}`;
  if (!withDay) return times;
  if (endDay !== startDay) return `${dayLabel(startDay)} ${clockIn(start, timeZone)} to ${dayLabel(endDay)} ${clockIn(end, timeZone)}`;
  return `${dayLabel(startDay)}, ${times}`;
}

// the style words of an event: tentative or not answered gets a hatch, declined is faded and struck through, and free
// time is lighter.
function blockClass(item: Item, base: string): string {
  const names = [base];
  if (item.kind === 'proposal') names.push('is-proposal');
  else {
    const { event } = item;
    if (event.answer === 'declined') names.push('is-declined');
    else if (event.answer === 'needsAction' || event.answer === 'tentative' || event.status === 'tentative') names.push('is-tentative');
    if (event.showsAsFree) names.push('is-free');
  }
  return names.join(' ');
}

function ConflictMark() {
  return <span className="cal-mark-conflict" role="img" aria-label="Conflict" title="Conflict" />;
}

// a tight move sits in the top corner of the later event, where the owner has to arrive. the day view has room for
// its words, and the week view shows an amber dot that the key explains.
function TravelMark({ gap, words }: { gap: TravelGap; words: boolean }) {
  const label = `Tight move: ${plural(gap.gapMinutes, 'minute')} from ${gap.fromLocation} to ${gap.toLocation}`;
  return (
    <span className={words ? 'cal-mark-travel has-words' : 'cal-mark-travel'} role="img" aria-label={label} title={label} data-from={gap.from} data-to={gap.to}>
      {words ? 'tight move' : null}
    </span>
  );
}

// the words of a block for a screen reader and a hover: a proposal says so, and an invitation on two calendars names
// the other ones.
function copiesText(item: Item, page: CalendarData): string {
  if (item.kind !== 'event' || !item.copies.length) return '';
  const names = item.copies.map((copy) => page.calendars.find((each) => each.key === copy.event.calendarKey)?.label ?? copy.event.account);
  return `, also on ${names.join(', ')}`;
}

interface GridProps {
  page: CalendarData;
  items: Item[];
  marks: Marks;
  mode: 'week' | 'day';
  today: string;
  now: number;
  selected: string | null;
  onSelect: (key: string) => void;
  onOpenDay: (day: string) => void;
}

const HOUR_PX = { week: 44, day: 56 } as const;
// the height of a line of text in a block, as calendar.css sets it.
const LINE_PX = 14;
// a week column is narrow, so a cluster shows at most two columns there, and the rest opens the day. a day column has
// room for six.
const MAX_COLUMNS = { week: 2, day: 6 } as const;

// a later block lies over an earlier one, so the title at the top of each block stays in view in a staggered cluster.
function TimedBlock({
  block,
  layer,
  page,
  marks,
  ppm,
  startMinute,
  selected,
  travel,
  words,
  onSelect,
}: {
  block: DayBlock<Item>;
  layer: number;
  page: CalendarData;
  marks: Marks;
  ppm: number;
  startMinute: number;
  selected: boolean;
  travel: TravelGap | undefined;
  words: boolean;
  onSelect: () => void;
}) {
  const { item } = block;
  const time = whenOf(item, page.timeZone, false);
  const start = block.clippedStart ? '' : clockIn(Date.parse(item.startAt), page.timeZone);
  const end = block.clippedEnd ? '' : clockIn(Date.parse(item.endAt), page.timeZone);
  const short = `${start}–${end}`;
  const height = Math.max(block.height * ppm, 20);
  // the lines of text that fit in the block. the title takes all but the last one, and the time takes the last, so
  // no line shows cut in half.
  const lines = Math.floor((height - 6) / LINE_PX);
  const roomLines = Math.min(lines, Math.floor((Math.max(block.room * ppm, 20) - 6) / LINE_PX));
  const conflict = item.kind === 'event' && marks.conflicts.has(item.key);
  const second = item.kind === 'event' ? item.copies[0]?.color : undefined;
  const style = {
    ...colorStyle(item.color),
    ...(second ? { '--cal2': second } : {}),
    top: (block.top - startMinute) * ppm,
    height: height - 2,
    left: `calc(${block.left * 100}% + 1px)`,
    width: `calc(${block.width * 100}% - 3px)`,
    zIndex: selected ? 900 : layer,
    '--title-lines': Math.max(1, roomLines - 1),
  } as CSSProperties;
  return (
    <button
      type="button"
      className={`${blockClass(item, 'cal-block')}${selected ? ' is-selected' : ''}${second ? ' has-copies' : ''}${conflict ? ' has-conflict' : ''}${travel ? ' has-travel' : ''}${lines < 2 ? ' is-short' : roomLines < 2 ? ' no-time' : ''}`}
      style={style}
      data-key={item.key}
      aria-pressed={selected}
      title={`${item.kind === 'proposal' ? 'Proposed: ' : ''}${item.title}, ${time}${copiesText(item, page)}`}
      onClick={onSelect}
    >
      {/* the dashed outline shows a proposal, and the key under the legend says so. the word is for a screen reader. */}
      {item.kind === 'proposal' ? <span className="sr-only">Proposed: </span> : null}
      <span className="cal-block-title">{item.title}</span>
      <span className="cal-block-time">{short}</span>
      {conflict ? <ConflictMark /> : null}
      {travel ? <TravelMark gap={travel} words={words} /> : null}
    </button>
  );
}

function Bar({ bar, page, marks, selected, onSelect }: { bar: AllDayBar<Item>; page: CalendarData; marks: Marks; selected: boolean; onSelect: () => void }) {
  const { item } = bar;
  return (
    <button
      type="button"
      className={`${blockClass(item, 'cal-bar')}${selected ? ' is-selected' : ''}${bar.continuesBefore ? ' from-before' : ''}${bar.continuesAfter ? ' to-after' : ''}`}
      style={{ ...colorStyle(item.color), gridColumn: `${bar.start + 1} / span ${bar.span}`, gridRow: bar.lane + 1 }}
      data-key={item.key}
      aria-pressed={selected}
      title={`${item.kind === 'proposal' ? 'Proposed: ' : ''}${item.title}, ${whenOf(item, page.timeZone)}${copiesText(item, page)}`}
      onClick={onSelect}
    >
      {item.kind === 'proposal' ? <span className="sr-only">Proposed: </span> : null}
      <span className="cal-block-title">{item.title}</span>
      {item.kind === 'event' && marks.conflicts.has(item.key) ? <ConflictMark /> : null}
    </button>
  );
}

// the week or day grid: the day headings, the all-day row, then a column for each day with the hours of the range.
export function Grid({ page, items, marks, mode, today, now, selected, onSelect, onOpenDay }: GridProps) {
  const days = page.days;
  const perDay = days.map((day) => foldDense(layoutDay(items, day, page.timeZone), MAX_COLUMNS[mode]));
  const { startHour, endHour } = hourRange(perDay.flatMap((each) => [...each.blocks, ...each.more]));
  const startMinute = startHour * 60;
  const hourPx = HOUR_PX[mode];
  const ppm = hourPx / 60;
  const bars = allDayRow(items, days);
  const lanes = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);
  const visible = new Set(items.map((each) => each.key));
  const columns = { '--days': days.length } as CSSProperties;
  return (
    <div className={`cal-grid cal-${mode}`} style={columns} aria-label={mode === 'week' ? 'week' : 'day'} role="region">
      <div className="cal-row cal-head">
        <div className="cal-gutter" />
        {days.map((day) => (
          <div key={day} className={day === today ? 'cal-dayhead is-today' : 'cal-dayhead'}>
            {mode === 'week' ? (
              <button type="button" className="cal-dayhead-button" title={`Open ${dayLabel(day)}`} onClick={() => onOpenDay(day)}>
                <span className="cal-dayhead-weekday">{weekdayOf(day)}</span> <span className="cal-dayhead-date">{dateOf(day)}</span>
              </button>
            ) : (
              <span className="cal-dayhead-button">
                <span className="cal-dayhead-weekday">{weekdayOf(day)}</span> <span className="cal-dayhead-date">{dateOf(day)}</span>
              </span>
            )}
          </div>
        ))}
      </div>
      {lanes ? (
        <div className="cal-row cal-allday">
          <div className="cal-gutter cal-gutter-label">All day</div>
          <div className="cal-allday-bars" style={{ gridTemplateRows: `repeat(${lanes}, auto)` }}>
            {bars.map((bar) => (
              <Bar key={bar.item.key} bar={bar} page={page} marks={marks} selected={itemIs(bar.item, selected)} onSelect={() => onSelect(bar.item.key)} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="cal-row cal-body" style={{ height: (endHour - startHour) * hourPx }}>
        <div className="cal-gutter cal-hours" aria-hidden="true">
          {Array.from({ length: endHour - startHour }, (_, index) => (
            <span key={index} className="cal-hour" style={{ top: index * hourPx }}>
              {hourLabel(startHour + index)}
            </span>
          ))}
        </div>
        {days.map((day, index) => {
          const folded = perDay[index]!;
          const isToday = day === today;
          const nowMinute = isToday ? wallMinutes(now, page.timeZone) : -1;
          // a gap shows on the later event, and only when both events are on the page.
          const travel = new Map(page.travelGaps.filter((gap) => visible.has(gap.from) && visible.has(gap.to)).map((gap) => [gap.to, gap]));
          return (
            <div key={day} className={isToday ? 'cal-col is-today' : 'cal-col'} style={{ backgroundSize: `100% ${hourPx}px` }} data-day={day}>
              {folded.blocks.map((block, order) => (
                <TimedBlock
                  key={block.item.key}
                  block={block}
                  layer={order + 1}
                  page={page}
                  marks={marks}
                  ppm={ppm}
                  startMinute={startMinute}
                  selected={itemIs(block.item, selected)}
                  travel={travel.get(block.item.key)}
                  words={mode === 'day'}
                  onSelect={() => onSelect(block.item.key)}
                />
              ))}
              {folded.more.map((more) => (
                <button
                  key={`more-${more.cluster}`}
                  type="button"
                  className="cal-more"
                  style={{
                    zIndex: 800,
                    top: (more.top - startMinute) * ppm,
                    height: Math.max(more.height * ppm, 20) - 2,
                    left: `calc(${(more.column / more.columns) * 100}% + 1px)`,
                    width: `calc(${100 / more.columns}% - 3px)`,
                  }}
                  title={more.items.map((each) => each.title).join(', ')}
                  onClick={() => onOpenDay(day)}
                >
                  +{more.items.length} more
                </button>
              ))}
              {/* the now line runs under the blocks, so it never strikes through the text of an event. its dot stays on
                  top at the edge of the column. */}
              {nowMinute >= startMinute && nowMinute <= endHour * 60 ? (
                <>
                  <div className="cal-now" style={{ top: (nowMinute - startMinute) * ppm }} aria-label={`now, ${clockIn(now, page.timeZone)}`} role="img" />
                  <div className="cal-now-dot" style={{ top: (nowMinute - startMinute) * ppm }} aria-hidden="true" />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaBadges({ item, marks }: { item: Item; marks: Marks }) {
  if (item.kind === 'proposal') return <Badge tone="info">Proposed</Badge>;
  return (
    <>
      {marks.conflicts.has(item.key) ? <Badge tone="critical">Conflict</Badge> : null}
      {marks.travelTo.has(item.key) ? <Badge tone="warning">Tight move</Badge> : null}
      {marks.invites.has(item.key) ? <Badge tone="warning">Not answered</Badge> : null}
      {item.event.answer === 'declined' ? <Badge tone="muted">Declined</Badge> : null}
    </>
  );
}

function AgendaRow({ item, time, marks, selected, onSelect }: { item: Item; time: ReactNode; marks: Marks; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className={`${blockClass(item, 'cal-agenda-item')}${selected ? ' is-selected' : ''}`} style={colorStyle(item.color)} data-key={item.key} aria-pressed={selected} onClick={onSelect}>
        <span className="cal-agenda-time">{time}</span>
        <span className="cal-agenda-dot" aria-hidden="true" />
        <span className="cal-agenda-main">
          <span className="cal-agenda-title">{item.title}</span>
          {item.kind === 'event' && item.event.location ? <span className="cal-agenda-where">{item.event.location}</span> : null}
          {item.kind === 'event' && item.copies.length ? <span className="cal-agenda-where">{plural(item.copies.length + 1, 'calendar')}</span> : null}
          <span className="cal-agenda-badges">
            <AgendaBadges item={item} marks={marks} />
          </span>
        </span>
      </button>
    </li>
  );
}

// the agenda of a narrow screen: each day as a heading, then its all-day items, then its timed items in order.
export function Agenda({ page, items, marks, today, selected, onSelect }: { page: CalendarData; items: Item[]; marks: Marks; today: string; selected: string | null; onSelect: (key: string) => void }) {
  return (
    <div className="cal-agenda" role="region" aria-label="agenda">
      {page.days.map((day) => {
        const bars = allDayRow(items, [day]);
        const blocks = layoutDay(items, day, page.timeZone);
        return (
          <section key={day} className={day === today ? 'cal-agenda-day is-today' : 'cal-agenda-day'} aria-label={dayLabel(day)}>
            <h2 className="cal-agenda-head">
              {dayLabel(day)}
              {day === today ? <span className="cal-agenda-today">Today</span> : null}
            </h2>
            {bars.length || blocks.length ? (
              <ul className="cal-agenda-list">
                {bars.map((bar) => (
                  <AgendaRow key={bar.item.key} item={bar.item} time="All day" marks={marks} selected={itemIs(bar.item, selected)} onSelect={() => onSelect(bar.item.key)} />
                ))}
                {blocks.map((block) => {
                  const start = block.clippedStart ? null : clockIn(Date.parse(block.item.startAt), page.timeZone);
                  const end = block.clippedEnd ? null : clockIn(Date.parse(block.item.endAt), page.timeZone);
                  const time = start && end ? `${start}–${end}` : start ? `from ${start}` : end ? `until ${end}` : 'all day';
                  return <AgendaRow key={block.item.key} item={block.item} time={time} marks={marks} selected={itemIs(block.item, selected)} onSelect={() => onSelect(block.item.key)} />;
                })}
              </ul>
            ) : (
              <p className="cal-agenda-none">Nothing planned.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

const ANSWER: Record<string, string> = { needsAction: 'Not answered', accepted: 'Going', tentative: 'Maybe', declined: 'Not going' };
const ANSWER_TONE: Record<string, 'good' | 'warning' | 'muted' | 'info'> = { needsAction: 'warning', accepted: 'good', tentative: 'info', declined: 'muted' };

function webLink(href: string | null, httpsOnly: boolean): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:') ? url.href : null;
  } catch {
    return null;
  }
}

// a long guest list shows its counts first, and the names after a click.
const GUESTS_SHOWN = 8;

function Guests({ guests }: { guests: CalendarGuest[] }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const guest of guests) counts.set(guest.answer, (counts.get(guest.answer) ?? 0) + 1);
  const summary = [...counts.entries()].map(([answer, count]) => `${count} ${(ANSWER[answer] ?? answer).toLowerCase()}`).join(', ');
  if (guests.length > GUESTS_SHOWN && !open)
    return (
      <div>
        <p className="cal-guests-summary">
          {plural(guests.length, 'guest')}: {summary}
        </p>
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          Show the guests
        </button>
      </div>
    );
  return (
    <ul className="cal-guests">
      {guests.map((guest, index) => (
        <li key={`${guest.email ?? guest.name ?? ''}-${index}`}>
          <span className="cal-guest-name">
            {/* a guest with an address opens the people profile through the person chip of the people view. */}
            {guest.email && !guest.self ? <PersonChip email={guest.email} name={guest.name} /> : (guest.name ?? guest.email ?? 'a guest')}
            {guest.self ? ' (you)' : ''}
            {guest.organizer ? ' · organizer' : ''}
            {guest.optional ? ' · optional' : ''}
          </span>
          <Badge tone={ANSWER_TONE[guest.answer] ?? 'muted'}>{ANSWER[guest.answer] ?? guest.answer}</Badge>
        </li>
      ))}
    </ul>
  );
}

function CalendarChip({ calendar, color }: { calendar: CalendarInfo | undefined; color: string }) {
  return (
    <span className="cal-detail-chip">
      <Dot color={color} />
      {calendar ? (calendar.label === calendar.account ? calendar.label : `${calendar.label} · ${calendar.account}`) : 'a calendar'}
    </span>
  );
}

function Notes({ marks, item, page }: { marks: Marks; item: Item; page: CalendarData }) {
  const conflicts = marks.conflicts.get(item.key) ?? [];
  const into = marks.travelTo.get(item.key);
  const out = marks.travelFrom.get(item.key);
  if (!conflicts.length && !into && !out) return null;
  return (
    <ul className="cal-notes" aria-label="notes">
      {conflicts.map((conflict) => {
        const other = conflict.a === item.key ? conflict.b : conflict.a;
        return (
          <li key={`${conflict.a}|${conflict.b}`} className="cal-note is-conflict">
            Conflicts with {marks.titles.get(other) ?? 'another event'} from {clockIn(Date.parse(conflict.startAt), page.timeZone)} to {clockIn(Date.parse(conflict.endAt), page.timeZone)}.
          </li>
        );
      })}
      {into ? (
        <li className="cal-note is-travel">
          Tight move: {plural(into.gapMinutes, 'minute')} to get from {into.fromLocation} ({marks.titles.get(into.from) ?? 'the event before'}) to {into.toLocation}.
        </li>
      ) : null}
      {out ? (
        <li className="cal-note is-travel">
          Tight move: {plural(out.gapMinutes, 'minute')} to get from {out.fromLocation} to {out.toLocation} ({marks.titles.get(out.to) ?? 'the next event'}).
        </li>
      ) : null}
    </ul>
  );
}

// the full title of the selected item at the top of the details, wrapped, as the today page shows it. the header of
// the panel has one line, and a long title would be cut there.
export function DetailsTitle({ title }: { title: string }) {
  return <h3 className="cal-details-title">{title}</h3>;
}

export function EventDetails({ item, page, marks }: { item: Extract<Item, { kind: 'event' }>; page: CalendarData; marks: Marks }) {
  const { event } = item;
  const calendarOf = (key: string) => page.calendars.find((each) => each.key === key);
  const video = webLink(event.videoUrl, false);
  const open = webLink(event.htmlLink, true);
  const cut = event.notes?.endsWith('…') === true;
  return (
    <>
      <DetailsTitle title={item.title} />
      <Notes marks={marks} item={item} page={page} />
      <Facts
        layout="stacked"
        items={[
          {
            label: item.copies.length ? 'Calendars' : 'Calendar',
            value: (
              <span className="cal-detail-chips">
                <CalendarChip calendar={calendarOf(event.calendarKey)} color={item.color} />
                {item.copies.map((copy) => (
                  <CalendarChip key={copy.event.key} calendar={calendarOf(copy.event.calendarKey)} color={copy.color} />
                ))}
              </span>
            ),
          },
          { label: 'When', value: whenOf(item, page.timeZone) },
          event.status === 'tentative' ? { label: 'Status', value: <Badge tone="info">tentative</Badge> } : null,
          event.location ? { label: 'Where', value: <span className="cal-text">{event.location}</span> } : null,
          video
            ? {
                label: 'Video',
                value: (
                  <a href={video} target="_blank" rel="noopener noreferrer" className="cal-text">
                    {video}
                  </a>
                ),
              }
            : event.videoUrl
              ? { label: 'Video', value: <code className="cal-text">{event.videoUrl}</code> }
              : null,
          { label: 'Organizer', value: event.organizerSelf ? 'You' : <span className="cal-text">{event.organizer ?? 'not given'}</span> },
          event.answer ? { label: 'Your answer', value: <Badge tone={ANSWER_TONE[event.answer] ?? 'muted'}>{ANSWER[event.answer] ?? event.answer}</Badge> } : null,
          event.guests.length ? { label: 'Guests', value: <Guests guests={event.guests} /> } : null,
          event.notes
            ? {
                label: 'Notes',
                value: (
                  <div className="cal-notes-text">
                    {event.notes}
                    {cut && open ? <p className="cal-notes-more">The notes go on in Google Calendar.</p> : null}
                  </div>
                ),
              }
            : null,
          event.recurring ? { label: 'Repeats', value: 'This event is one of a series.' } : null,
          event.showsAsFree ? { label: 'Busy', value: 'Shows as free.' } : null,
        ]}
      />
      {open ? (
        <div>
          <ButtonLink href={open} target="_blank" rel="noopener noreferrer" size="sm" icon="external">
            Open in Google Calendar
          </ButtonLink>
        </div>
      ) : null}
    </>
  );
}

export function ProposalDetails({ item, page, onDecided }: { item: Extract<Item, { kind: 'proposal' }>; page: CalendarData; onDecided: () => void }) {
  const { proposal } = item;
  const approvals = useApprovals();
  return (
    <>
      <DetailsTitle title={item.title} />
      <p className="cal-proposal-note">The digest proposed this event from your mail. It reaches the calendar only when you approve it.</p>
      <Facts
        layout="stacked"
        items={[
          { label: 'Kind', value: proposal.kind },
          { label: 'When', value: whenOf(item, page.timeZone) },
          { label: 'Account', value: proposal.account },
          { label: 'Proposal', value: <a href={`#/inbox/proposals?id=${proposal.proposalId}`}>Open proposal #{proposal.proposalId}</a> },
        ]}
      />
      {proposal.approvalId !== null ? (
        <ApprovalFor
          id={proposal.approvalId}
          approvals={approvals}
          onDecided={() => {
            approvals.reload();
            onDecided();
          }}
        />
      ) : null}
    </>
  );
}
