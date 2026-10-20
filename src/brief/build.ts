import type { BriefContent, BriefDelegation, BriefItem, BriefSection, BriefSectionKind, BriefSources } from '../dashboard/brief-types.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import type { CalendarProposalView, DigestItem, GoalRow, InboxDigest } from '../dashboard/types.js';
import { cleanLine } from '../signals/store.js';
import { addDays, localDay, localTime, zonedToUtc } from '../time.js';
import { byStart, dedupeCopies, eventsOfDay, findConflicts, findTravelGaps, unansweredInvites } from './analyze.js';

// the pure builder of a brief: it turns what the sources gave into the sections of the page and the short telegram
// text. nothing here reads the database or google, so a test gives it the input and checks the output.

// the brief reads the calendar from the start of its day to the end of this many days, for the invitations and the
// deadlines of the week. the day section shows only the day itself.
export const LOOKAHEAD_DAYS = 7;

// the telegram text has at most this many characters, the link included.
export const SHORT_TEXT_LIMIT = 700;

// everything the brief of one day is built from. day is yyyy-mm-dd in timeZone, and now is the time of the build.
// events cover the day and the LOOKAHEAD_DAYS after it. digest is the digest that the brief uses (of the day, or the
// newest one of the day before), or null. delegations is null when the desk module is not there. goals are the goals
// of the day. proposals are the calendar proposals in the state proposed.
export interface BriefInput {
  day: string;
  timeZone: string;
  now: Date;
  events: CalendarEvent[];
  sources: BriefSources;
  digest: InboxDigest | null;
  proposals: CalendarProposalView[];
  delegations: BriefDelegation[] | null;
  goals: GoalRow[];
}

const SECTION_TITLES: Record<BriefSectionKind, string> = {
  day: 'Today',
  conflicts: 'Conflicts',
  travel: 'Tight moves',
  invites: 'Invitations to answer',
  deadlines: 'Deadlines this week',
  inbox: 'Inbox',
  delegations: 'Delegations',
  goals: 'Goals',
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// the times and days of one brief, all in its time zone.
interface BriefClock {
  day: string;
  timeZone: string;
  now: number;
  dayStart: number;
  dayEnd: number;
  windowEnd: number;
}

// buildBrief gives the sections in the order of BriefSectionKind. each item has a source, so the page links it.
export function buildBrief(input: BriefInput): BriefContent {
  const { day, timeZone } = input;
  const clock: BriefClock = {
    day,
    timeZone,
    now: input.now.getTime(),
    dayStart: zonedToUtc(day, '00:00', timeZone).getTime(),
    dayEnd: zonedToUtc(addDays(day, 1), '00:00', timeZone).getTime(),
    windowEnd: zonedToUtc(addDays(day, LOOKAHEAD_DAYS + 1), '00:00', timeZone).getTime(),
  };
  const events = [...input.events].sort(byStart);
  const byKey = new Map(events.map((event) => [event.key, event]));

  const deadlines = deadlineItems(input, events, clock);
  const deadlineIds = new Set(deadlines.map((item) => item.id));
  const inbox = input.digest ? inboxSection(input.digest, deadlineIds, clock) : null;

  const sections: BriefSection[] = [
    daySection(events, input.sources, clock),
    section('conflicts', conflictItems(events, byKey, clock)),
    section('travel', travelItems(events, byKey, clock)),
    section('invites', inviteItems(events, input.now, clock)),
    section('deadlines', deadlines),
    inbox ? section('inbox', inbox.items, inbox.note) : section('inbox', []),
    section('delegations', delegationItems(input.delegations ?? [], clock)),
    section('goals', goalItems(input.goals, clock)),
  ].filter((each) => each.kind === 'day' || each.items.length > 0);

  return { day, timeZone, generatedAt: input.now.toISOString(), sections, sources: input.sources };
}

function section(kind: BriefSectionKind, items: BriefItem[], note: string | null = null): BriefSection {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { kind, title: SECTION_TITLES[kind], items: unique, note };
}

function daySection(events: CalendarEvent[], sources: BriefSources, clock: BriefClock): BriefSection {
  const today = dedupeCopies(eventsOfDay(events, clock.day, clock.timeZone));
  const items = today.map((event) => {
    const parts = [event.allDay ? 'All day' : `${hhmm(event.startAt, clock)} to ${hhmm(event.endAt, clock)}`];
    const location = event.location?.trim();
    if (location) parts.push(location);
    else if (event.videoUrl) parts.push('video');
    if (event.showsAsFree) parts.push('shows as free');
    let tone: BriefItem['tone'] = null;
    if (event.answer === 'needsAction') {
      parts.push('not answered');
      tone = 'warning';
    } else if (event.answer === 'tentative') parts.push('maybe');
    return eventItem(event, event.title, parts.join(' · '), tone);
  });
  return section('day', items, dayNote(today, sources, clock));
}

function dayNote(today: CalendarEvent[], sources: BriefSources, clock: BriefClock): string {
  if (sources.calendar === 'off') return 'Google is not set up, so the brief has no calendar.';
  if (sources.calendar === 'failed') return 'The calendars could not be read.';
  let note = 'No events today.';
  if (today.length > 0) {
    const first = firstTimed(today, clock);
    const count = plural(today.length, 'event', 'events');
    if (!first) note = `${count}.`;
    else note = today.length === 1 ? `${count}, at ${hhmm(first.startAt, clock)}.` : `${count}, the first at ${hhmm(first.startAt, clock)}.`;
  }
  if (sources.calendar === 'partial') {
    const accounts = [...new Set(sources.skipped.map((each) => each.account))];
    if (accounts.length > 0) note += ` The calendar of ${listWords(accounts)} could not be read.`;
  }
  return note;
}

// the first timed event that starts on the day. an event from the night before that runs into the day is not the
// first event of the day.
function firstTimed(today: CalendarEvent[], clock: BriefClock): CalendarEvent | undefined {
  return today.find((event) => !event.allDay && Date.parse(event.startAt) >= clock.dayStart);
}

function conflictItems(events: CalendarEvent[], byKey: Map<string, CalendarEvent>, clock: BriefClock): BriefItem[] {
  const items: BriefItem[] = [];
  for (const conflict of findConflicts(events)) {
    const start = Date.parse(conflict.startAt);
    const end = Date.parse(conflict.endAt);
    if (!(start < clock.dayEnd && end > clock.dayStart)) continue;
    const a = byKey.get(conflict.a)!;
    const b = byKey.get(conflict.b)!;
    items.push(eventItem(a, `${a.title} overlaps ${b.title}`, `${hhmm(conflict.startAt, clock)} to ${hhmm(conflict.endAt, clock)}`, 'critical'));
  }
  return items;
}

function travelItems(events: CalendarEvent[], byKey: Map<string, CalendarEvent>, clock: BriefClock): BriefItem[] {
  const items: BriefItem[] = [];
  for (const gap of findTravelGaps(events)) {
    const at = Date.parse(gap.at);
    if (at < clock.dayStart || at >= clock.dayEnd) continue;
    const from = byKey.get(gap.from)!;
    const to = byKey.get(gap.to)!;
    const minutes = plural(gap.gapMinutes, 'minute', 'minutes');
    items.push(eventItem(to, `${gap.fromLocation} to ${gap.toLocation}`, `${minutes} between ${from.title} and ${to.title}`, 'warning'));
  }
  return items;
}

function inviteItems(events: CalendarEvent[], now: Date, clock: BriefClock): BriefItem[] {
  return unansweredInvites(events, now).map((event) => {
    const when = event.allDay ? dayWord(event.startDay, clock) : `${dayWord(localDay(new Date(event.startAt), clock.timeZone), clock)} ${hhmm(event.startAt, clock)}`;
    const detail = event.organizer ? `${when} · from ${event.organizer}` : when;
    return eventItem(event, event.title, detail, 'warning');
  });
}

// a deadline item with the time that it sorts by. a date alone sorts at the start of its day.
interface Deadline {
  item: BriefItem;
  sortAt: number;
}

function deadlineItems(input: BriefInput, events: CalendarEvent[], clock: BriefClock): BriefItem[] {
  const found: Deadline[] = [];
  const inWindow = (start: number, end: number) => start < clock.windowEnd && end > clock.dayStart;

  if (input.digest) {
    for (const each of input.digest.items) {
      if (each.section !== 'deadlines' || !each.dueAt) continue;
      const due = dueOf(each.dueAt, clock);
      if (!due || !inWindow(due.start, due.end)) continue;
      found.push({
        item: threadItem(input.digest.id, each, digestTitle(each), `Due ${due.when} · from the inbox`, due.at, toneOf(due.end, clock)),
        sortAt: due.start,
      });
    }
  }

  const visible = events.filter((event) => event.status !== 'cancelled' && event.answer !== 'declined' && /\b(due|deadline)\b/i.test(event.title));
  for (const event of dedupeCopies(visible)) {
    const start = Date.parse(event.startAt);
    const end = Math.max(Date.parse(event.endAt), start + 1);
    if (!inWindow(start, end)) continue;
    const dueBy = event.allDay ? zonedToUtc(addDays(event.startDay, 1), '00:00', clock.timeZone).getTime() : start;
    const when = event.allDay ? dayWord(event.startDay, clock) : `${dayWord(localDay(new Date(start), clock.timeZone), clock)} ${hhmm(event.startAt, clock)}`;
    const location = event.location?.trim();
    found.push({ item: eventItem(event, event.title, location ? `${when} · ${location}` : when, toneOf(dueBy, clock)), sortAt: start });
  }

  for (const proposal of input.proposals) {
    if (proposal.state !== 'proposed') continue;
    const span = proposalSpan(proposal, clock);
    if (!span || !inWindow(span.start, span.end)) continue;
    found.push({
      item: {
        id: `proposal:${proposal.id}`,
        title: proposal.title,
        detail: `${span.when} · proposed, waiting for your approval`,
        at: span.at,
        account: proposal.account,
        tone: toneOf(span.dueBy, clock),
        source: { kind: 'proposal', proposalId: proposal.id },
      },
      sortAt: span.start,
    });
  }

  return found.sort((a, b) => a.sortAt - b.sortAt || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)).map((each) => each.item);
}

// a due time of the digest: a date alone is due at the end of that day, and a time is due at that time.
function dueOf(value: string, clock: BriefClock): { at: string; start: number; end: number; when: string } | null {
  if (DATE_ONLY.test(value)) {
    const start = zonedToUtc(value, '00:00', clock.timeZone).getTime();
    const end = zonedToUtc(addDays(value, 1), '00:00', clock.timeZone).getTime() - 1;
    return { at: value, start, end, when: dayWord(value, clock) };
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return { at: value, start: at, end: at, when: `${dayWord(localDay(new Date(at), clock.timeZone), clock)} ${hhmm(value, clock)}` };
}

// the time of a proposal. an all-day proposal holds a date, or the midnight of its date in the time zone of the app.
function proposalSpan(proposal: CalendarProposalView, clock: BriefClock): { at: string; start: number; end: number; dueBy: number; when: string } | null {
  if (proposal.allDay) {
    const first = dayOfValue(proposal.startAt, clock);
    if (!first) return null;
    const last = (proposal.endAt && dayOfValue(proposal.endAt, clock)) || first;
    const start = zonedToUtc(first, '00:00', clock.timeZone).getTime();
    const end = zonedToUtc(addDays(last >= first ? last : first, 1), '00:00', clock.timeZone).getTime();
    const dueBy = zonedToUtc(addDays(first, 1), '00:00', clock.timeZone).getTime() - 1;
    return { at: first, start, end, dueBy, when: dayWord(first, clock) };
  }
  const start = Date.parse(proposal.startAt);
  if (!Number.isFinite(start)) return null;
  const endAt = proposal.endAt ? Date.parse(proposal.endAt) : NaN;
  const end = Number.isFinite(endAt) && endAt > start ? endAt : start + 1;
  const when = `${dayWord(localDay(new Date(start), clock.timeZone), clock)} ${hhmm(proposal.startAt, clock)}`;
  return { at: proposal.startAt, start, end, dueBy: start, when };
}

function dayOfValue(value: string, clock: BriefClock): string | null {
  if (DATE_ONLY.test(value)) return value;
  const at = Date.parse(value);
  return Number.isFinite(at) ? localDay(new Date(at), clock.timeZone) : null;
}

// a deadline before now is late, and one of the day needs the owner today.
function toneOf(dueBy: number, clock: BriefClock): BriefItem['tone'] {
  if (dueBy < clock.now) return 'critical';
  if (dueBy >= clock.dayStart && dueBy < clock.dayEnd) return 'warning';
  return null;
}

function inboxSection(digest: InboxDigest, deadlineIds: Set<string>, clock: BriefClock): { items: BriefItem[]; note: string } {
  const replies: BriefItem[] = [];
  const bills: BriefItem[] = [];
  const packages: BriefItem[] = [];
  const seen = new Set(deadlineIds);
  for (const each of digest.items) {
    const id = `thread:${each.account}:${each.threadId}`;
    if (each.section === 'deadlines' || seen.has(id)) continue;
    seen.add(id);
    const due = each.dueAt ? dueOf(each.dueAt, clock) : null;
    if (each.section === 'needs_reply') {
      replies.push(threadItem(digest.id, each, digestTitle(each), each.draftId !== null ? 'A draft is in Gmail Drafts' : null, null, 'warning'));
    } else if (each.section === 'bills') {
      const amount = each.amount !== null ? `, ${formatAmount(each.amount, each.currency)}` : '';
      bills.push(threadItem(digest.id, each, `${digestTitle(each)}${amount}`, due ? `Due ${due.when}` : null, due?.at ?? null, null));
    } else if (each.section === 'packages') {
      const arrives = due ? (localDay(new Date(due.start), clock.timeZone) === clock.day ? 'Arrives today' : `Arrives ${due.when}`) : null;
      packages.push(threadItem(digest.id, each, digestTitle(each), arrives, due?.at ?? null, null));
    }
  }
  const counts = [
    replies.length ? `${replies.length} ${replies.length === 1 ? 'needs' : 'need'} a reply` : null,
    bills.length ? plural(bills.length, 'bill', 'bills') : null,
    packages.length ? plural(packages.length, 'package', 'packages') : null,
  ].filter((part): part is string => part !== null);
  let note = counts.length ? `${counts.join(', ')}.` : 'Nothing in the inbox needs you.';
  if (digest.day < clock.day) note += ` From the digest of ${digest.day}.`;
  return { items: [...replies, ...bills, ...packages], note };
}

function digestTitle(item: DigestItem): string {
  return cleanLine(item.summary || item.subject, 300);
}

function threadItem(digestId: number, each: DigestItem, title: string, detail: string | null, at: string | null, tone: BriefItem['tone']): BriefItem {
  return {
    id: `thread:${each.account}:${each.threadId}`,
    title,
    detail,
    at,
    account: each.account,
    tone,
    source: { kind: 'thread', account: each.account, threadId: each.threadId, digestId },
  };
}

function formatAmount(amount: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    } catch {
      // a code that is not a currency shows after the number.
      return `${amount.toFixed(2)} ${currency}`;
    }
  }
  return amount.toFixed(2);
}

function delegationItems(delegations: BriefDelegation[], clock: BriefClock): BriefItem[] {
  return delegations
    .filter((each) => each.status !== 'done' && each.status !== 'dropped')
    .map((each) => {
      const due = each.dueAt ? Date.parse(each.dueAt) : NaN;
      const followUp = each.followUpAt ? Date.parse(each.followUpAt) : NaN;
      const onDay = (at: number) => at >= clock.dayStart && at < clock.dayEnd;
      const parts: string[] = [];
      if (each.waitingOn) parts.push(`Waiting on ${each.waitingOn}`);
      if (Number.isFinite(due)) parts.push(`due ${onDay(due) ? 'today' : dayWord(localDay(new Date(due), clock.timeZone), clock)}`);
      if (Number.isFinite(followUp) && onDay(followUp)) parts.push('Follow up today');
      const detail = parts.length ? capitalize(parts.join(' · ')) : null;
      let tone: BriefItem['tone'] = null;
      if (Number.isFinite(due) && due < clock.now) tone = 'critical';
      else if ((Number.isFinite(due) && onDay(due)) || (Number.isFinite(followUp) && onDay(followUp))) tone = 'warning';
      return {
        id: `delegation:${each.id}`,
        title: each.title,
        detail,
        at: each.dueAt ?? each.followUpAt,
        account: null,
        tone,
        source: { kind: 'delegation', delegationId: each.id },
      } satisfies BriefItem;
    });
}

function goalItems(goals: GoalRow[], clock: BriefClock): BriefItem[] {
  return [...goals]
    .sort((a, b) => a.id - b.id)
    .filter((goal) => goal.status !== 'dropped')
    .map((goal) => {
      const done = goal.status === 'done';
      const detail = done ? 'done' : goal.eta ? `by ${hhmm(goal.eta, clock)}` : null;
      return {
        id: `goal:${goal.id}`,
        title: goal.title,
        detail,
        at: done ? goal.completedAt : goal.eta,
        account: null,
        tone: null,
        source: { kind: 'goal', goalId: goal.id },
      } satisfies BriefItem;
    });
}

// an event item: an all-day event is about its first day, and a timed event is about its start.
function eventItem(event: CalendarEvent, title: string, detail: string | null, tone: BriefItem['tone']): BriefItem {
  return {
    id: `event:${event.key}`,
    title,
    detail,
    at: event.allDay ? event.startDay : event.startAt,
    account: event.account,
    tone,
    source: { kind: 'event', key: event.key, day: event.startDay },
  };
}

function hhmm(iso: string, clock: BriefClock): string {
  return localTime(new Date(iso), clock.timeZone);
}

// 'Today' for the day of the brief, and the short weekday for another day.
function dayWord(day: string, clock: BriefClock): string {
  return day === clock.day ? 'Today' : weekdayOf(day);
}

function weekdayOf(day: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// briefText is the short telegram message: plain text, no markdown, at most SHORT_TEXT_LIMIT characters, and the link
// on its last line.
export function briefText(content: BriefContent, link: string): string {
  const date = new Date(`${content.day}T12:00:00Z`);
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
  const first = `Brief for ${weekdayOf(content.day)} ${date.getUTCDate()} ${month}`;
  const count = (kind: BriefSectionKind) => content.sections.find((each) => each.kind === kind)?.items.length ?? 0;

  const middle: string[] = [dayLine(content)];

  const checks = [
    count('conflicts') ? plural(count('conflicts'), 'conflict', 'conflicts') : null,
    count('travel') ? plural(count('travel'), 'tight move', 'tight moves') : null,
    count('invites') ? plural(count('invites'), 'invitation to answer', 'invitations to answer') : null,
  ].filter((part): part is string => part !== null);
  if (checks.length) middle.push(`${checks.join(', ')}.`);

  // the note of the inbox section starts with its counts, which hold no outside text.
  const inboxNote = content.sections.find((each) => each.kind === 'inbox')?.note ?? null;
  const work = [
    count('deadlines') ? `${plural(count('deadlines'), 'deadline', 'deadlines')} this week.` : null,
    count('inbox') && inboxNote ? `Inbox: ${inboxNote.split('. ')[0]!.replace(/\.$/, '')}.` : null,
  ].filter((part): part is string => part !== null);
  if (work.length) middle.push(work.join(' '));

  const desk = [
    count('delegations') ? plural(count('delegations'), 'delegation', 'delegations') : null,
    count('goals') ? plural(count('goals'), 'goal', 'goals') : null,
  ].filter((part): part is string => part !== null);
  if (desk.length) middle.push(`${desk.join(', ')}.`);

  // the last lines go first when the text is too long. the first line and the link always stay.
  const total = (lines: string[]) => [first, ...lines, link].join('\n').length;
  while (middle.length > 0 && total(middle) > SHORT_TEXT_LIMIT) middle.pop();
  return [first, ...middle, link].join('\n');
}

// the line about the events of the day. the title of the first event is the only outside text of the message.
function dayLine(content: BriefContent): string {
  const day = content.sections.find((each) => each.kind === 'day');
  const items = day?.items ?? [];
  if (content.sources.calendar === 'failed') return 'The calendars could not be read.';
  if (items.length === 0) return 'No events today.';
  const dayStart = zonedToUtc(content.day, '00:00', content.timeZone).getTime();
  const timed = items.find((item) => item.at !== null && !DATE_ONLY.test(item.at) && Date.parse(item.at) >= dayStart);
  const events = plural(items.length, 'event', 'events');
  if (!timed) return `${events}.`;
  const title = cleanLine(timed.title, 60);
  return `${events}, first at ${localTime(new Date(timed.at!), content.timeZone)} ${title}.`;
}
