// the pure helpers of the calendar page: the days of a week, the clock of a time in a time zone, the blocks of a day
// with their columns, the bars of the all-day row and the hours that the grid shows. nothing here reads the page or
// the browser, so each helper is tested on its own.

// the part of an event or a proposal that the layout reads. startAt and endAt are utc. startDay and endDay are days of
// the time zone of the app, and endDay is the last day, inclusive.
export interface Span {
  key: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  startDay: string;
  endDay: string;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// a day is yyyy-mm-dd of the gregorian calendar, with no time zone.
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(value: string | null | undefined): value is string {
  const match = value ? DAY.exec(value) : null;
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

// the monday of the week of a day. a week starts on monday.
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export function daysFrom(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(first, index));
}

// the number of days from one day to another.
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const partsFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let format = partsFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormats.set(timeZone, format);
  }
  return format;
}

interface WallTime {
  day: string;
  hour: number;
  minute: number;
  second: number;
}

// the day and the clock of an instant in a time zone.
export function wallTime(ms: number, timeZone: string): WallTime {
  const parts: Record<string, string> = {};
  for (const part of partsFormat(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

export function dayOf(ms: number, timeZone: string): string {
  return wallTime(ms, timeZone).day;
}

// the offset of the time zone at an instant, in milliseconds: the wall clock minus utc.
function offsetAt(ms: number, timeZone: string): number {
  const wall = wallTime(ms, timeZone);
  const asUtc = Date.parse(`${wall.day}T00:00:00Z`) + ((wall.hour * 60 + wall.minute) * 60 + wall.second) * 1000;
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// the instant of midnight at the start of a day in a time zone. the offset is read twice, so a day where the clock
// changes in the night still gets its own midnight.
export function zonedMidnight(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

// the minutes of the wall clock since midnight, so 09:00 is 540 on each day, also on a day where the clock changes.
export function wallMinutes(ms: number, timeZone: string): number {
  const wall = wallTime(ms, timeZone);
  return wall.hour * 60 + wall.minute;
}

// an item that lasts a whole day or longer goes to the all-day row. a shorter item that crosses midnight stays in
// the grid of each day that it touches.
export function isBar(item: Span): boolean {
  return item.allDay || Date.parse(item.endAt) - Date.parse(item.startAt) >= DAY_MS;
}

export interface DayBlock<T extends Span = Span> {
  item: T;
  // the minutes of the wall clock from midnight, after the clip to the day.
  top: number;
  height: number;
  // the item starts before the day or ends after it.
  clippedStart: boolean;
  clippedEnd: boolean;
  // the place of the block among the items that overlap it. the width of a block is 1 / columns.
  column: number;
  columns: number;
  // the items that overlap each other, also through a chain, share one cluster.
  cluster: number;
  // the place and the width of the block as parts of the day column, from 0 to 1. side by side, left is
  // column / columns. in a staggered cluster each block is indented under the one before it instead.
  left: number;
  width: number;
  // the minutes from the top of the block that no later block covers, so the text fits in them.
  room: number;
}

// a short item still gets this height in the layout, so two short items in a row do not cover each other.
export const MIN_BLOCK_MINUTES = 20;

// two overlapping items that start at least this far apart are staggered: the later one can sit over the earlier one,
// indented, and the title of the earlier one stays in view above it.
export const STAGGER_MINUTES = 30;
const INDENT = 0.18;

// a cluster is staggered when each two of its items that overlap start at least STAGGER_MINUTES apart.
function staggered(blocks: Array<{ top: number; height: number }>): boolean {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      const overlap = a.top < b.top + Math.max(b.height, MIN_BLOCK_MINUTES) && b.top < a.top + Math.max(a.height, MIN_BLOCK_MINUTES);
      if (overlap && Math.abs(a.top - b.top) < STAGGER_MINUTES) return false;
    }
  }
  return true;
}

// the timed items of a day as blocks, with the minutes of the wall clock from midnight. an item that crosses midnight
// is clipped to the day. the overlapping items share the width of the day in columns: the items are sorted by start,
// cut into clusters of items that overlap, and each item takes the first column that is free at its start.
export function layoutDay<T extends Span>(items: T[], day: string, timeZone: string): Array<DayBlock<T>> {
  const dayStart = zonedMidnight(day, timeZone);
  const dayEnd = zonedMidnight(addDays(day, 1), timeZone);
  const placed: Array<Omit<DayBlock<T>, 'column' | 'columns' | 'cluster' | 'left' | 'width' | 'room'>> = [];
  for (const item of items) {
    if (isBar(item)) continue;
    const start = Date.parse(item.startAt);
    const end = Math.max(Date.parse(item.endAt), start);
    // an item of no length still shows at its start.
    if (start >= dayEnd || end < dayStart || (end === dayStart && end > start)) continue;
    const clippedStart = start < dayStart;
    const clippedEnd = end > dayEnd;
    const from = clippedStart ? dayStart : start;
    const to = clippedEnd ? dayEnd : end;
    const top = clippedStart ? 0 : wallMinutes(from, timeZone);
    // the end uses the wall clock too. on the night where the clock goes back, the wall clock of the end can be before
    // the start, and then the block keeps its real length.
    let bottom = clippedEnd ? 24 * 60 : wallMinutes(to, timeZone);
    if (!clippedEnd && to >= dayEnd) bottom = 24 * 60;
    if (bottom < top || (bottom === top && to > from)) bottom = top + Math.round((to - from) / MINUTE_MS);
    bottom = Math.min(bottom, 24 * 60);
    placed.push({ item, top, height: bottom - top, clippedStart, clippedEnd });
  }
  placed.sort((a, b) => a.top - b.top || b.height - a.height || a.item.key.localeCompare(b.item.key));

  const blocks: Array<DayBlock<T>> = [];
  let cluster: Array<DayBlock<T>> = [];
  let clusterEnd = -1;
  let clusterId = -1;
  let columnEnds: number[] = [];
  const close = () => {
    const columns = columnEnds.length;
    const cascade = columns > 1 && staggered(cluster);
    for (const [index, block] of cluster.entries()) {
      block.columns = columns;
      block.left = cascade ? block.column * INDENT : block.column / columns;
      block.width = cascade ? 1 - block.left : 1 / columns;
      // in a cascade the next block that starts inside this one lies over the rest of it.
      const next = cascade ? cluster.slice(index + 1).find((later) => later.top < block.top + block.height) : undefined;
      block.room = next ? next.top - block.top : block.height;
    }
    cluster = [];
    columnEnds = [];
  };
  for (const each of placed) {
    const bottom = each.top + Math.max(each.height, MIN_BLOCK_MINUTES);
    if (each.top >= clusterEnd) {
      close();
      clusterId++;
    }
    let column = columnEnds.findIndex((end) => end <= each.top);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(bottom);
    } else columnEnds[column] = bottom;
    const block: DayBlock<T> = { ...each, column, columns: 1, cluster: clusterId, left: 0, width: 1, room: each.height };
    cluster.push(block);
    blocks.push(block);
    clusterEnd = Math.max(clusterEnd, bottom);
  }
  close();
  return blocks;
}

export interface FoldedDay<T extends Span = Span> {
  blocks: Array<DayBlock<T>>;
  // the blocks of a dense cluster that do not fit, drawn as one "+n more" block in the last column.
  more: Array<{ cluster: number; column: number; columns: number; top: number; height: number; items: T[] }>;
}

// a narrow day column cannot show many blocks side by side, so a cluster with more than maxColumns columns shows its
// first maxColumns - 1 columns and puts the rest into one block that opens the day.
export function foldDense<T extends Span>(blocks: Array<DayBlock<T>>, maxColumns: number): FoldedDay<T> {
  const shown: Array<DayBlock<T>> = [];
  const hidden = new Map<number, Array<DayBlock<T>>>();
  for (const block of blocks) {
    if (block.columns <= maxColumns || block.width > 1 / block.columns) shown.push(block);
    else if (block.column < maxColumns - 1) shown.push({ ...block, columns: maxColumns, left: block.column / maxColumns, width: 1 / maxColumns });
    else hidden.set(block.cluster, [...(hidden.get(block.cluster) ?? []), block]);
  }
  const more = [...hidden.entries()].map(([cluster, rest]) => {
    const top = Math.min(...rest.map((each) => each.top));
    const bottom = Math.max(...rest.map((each) => each.top + Math.max(each.height, MIN_BLOCK_MINUTES)));
    return { cluster, column: maxColumns - 1, columns: maxColumns, top, height: bottom - top, items: rest.map((each) => each.item) };
  });
  return { blocks: shown, more };
}

export interface AllDayBar<T extends Span = Span> {
  item: T;
  // the index of the first day in days, and the number of days that the bar covers in the range.
  start: number;
  span: number;
  // the row of the bar. two bars on the same day never share a lane.
  lane: number;
  // the item starts before the first day of the range or ends after the last one.
  continuesBefore: boolean;
  continuesAfter: boolean;
}

// the all-day and multi-day items of the range as bars. the longer bar of two that start on one day comes first, and
// each bar takes the first lane that is free on all of its days.
export function allDayRow<T extends Span>(items: T[], days: string[]): Array<AllDayBar<T>> {
  if (!days.length) return [];
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const bars: Array<Omit<AllDayBar<T>, 'lane'>> = [];
  for (const item of items) {
    if (!isBar(item)) continue;
    const endDay = item.endDay < item.startDay ? item.startDay : item.endDay;
    if (endDay < first || item.startDay > last) continue;
    const startIndex = Math.max(0, dayDiff(first, item.startDay));
    const endIndex = Math.min(days.length - 1, dayDiff(first, endDay));
    bars.push({ item, start: startIndex, span: endIndex - startIndex + 1, continuesBefore: item.startDay < first, continuesAfter: endDay > last });
  }
  bars.sort((a, b) => a.start - b.start || b.span - a.span || a.item.key.localeCompare(b.item.key));
  const laneEnds: number[] = [];
  return bars.map((bar) => {
    let lane = laneEnds.findIndex((end) => end < bar.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = bar.start + bar.span - 1;
    return { ...bar, lane };
  });
}

// the hours that the grid shows: from 07:00 or the first block, whichever is earlier, to 21:00 or the end of the last
// block, whichever is later.
export function hourRange(blocks: Array<{ top: number; height: number }>, earliest = 7, latest = 21): { startHour: number; endHour: number } {
  let startHour = earliest;
  let endHour = latest;
  for (const block of blocks) {
    startHour = Math.min(startHour, Math.floor(block.top / 60));
    endHour = Math.max(endHour, Math.ceil((block.top + Math.max(block.height, MIN_BLOCK_MINUTES)) / 60));
  }
  return { startHour: Math.max(0, startHour), endHour: Math.min(24, endHour) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function split(day: string): { year: number; month: number; date: number; weekday: number } {
  const date = new Date(`${day}T00:00:00Z`);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), date: date.getUTCDate(), weekday: date.getUTCDay() };
}

// a day as Mon 12 Oct.
export function dayLabel(day: string): string {
  const { month, date, weekday } = split(day);
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month]}`;
}

export function weekdayOf(day: string): string {
  return WEEKDAYS[split(day).weekday]!;
}

export function dateOf(day: string): number {
  return split(day).date;
}

// the title of a range: 12 – 18 Oct 2026 in one month, 28 Sep – 4 Oct 2026 across two, and 29 Dec 2025 – 4 Jan 2026
// across two years. one day is Mon 12 Oct 2026.
export function rangeTitle(first: string, last: string): string {
  const a = split(first);
  const b = split(last);
  if (first === last) return `${dayLabel(first)} ${a.year}`;
  if (a.year !== b.year) return `${a.date} ${MONTHS[a.month]} ${a.year} – ${b.date} ${MONTHS[b.month]} ${b.year}`;
  if (a.month !== b.month) return `${a.date} ${MONTHS[a.month]} – ${b.date} ${MONTHS[b.month]} ${b.year}`;
  return `${a.date} – ${b.date} ${MONTHS[b.month]} ${b.year}`;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

// the clock of an instant in a time zone, as 09:05.
export function clockIn(ms: number, timeZone: string): string {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clockFormats.set(timeZone, format);
  }
  return format.format(new Date(ms));
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

// a calendar color comes from google, so only a plain hex color reaches the style of a block.
export function safeColor(color: string | null | undefined): string {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#8a857c';
}
