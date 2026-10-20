import { useEffect, useRef, useState } from 'react';
import type { CalendarPage as CalendarData } from '../../../../src/dashboard/calendar-types';
import type { Meta, StreamMessage } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { plural } from '../../format';
import type { RouteProps } from '../../routes';
import { Button, ButtonLink, DetailsPanel, EmptyState, FilterBar, IconButton, Page, Segmented, Skeleton } from '../../ui';
import { setHashQuery } from '../inbox/shared';
import type { CalendarMode } from '../today/links';
import { addDays, dayOf, isDay, mondayOf, rangeTitle } from './grid';
import { Agenda, EventDetails, Grid, itemIs, Legend, MarksKey, MIN_DAY_PX, ProposalDetails, itemsOf, marksOf, useHidden, useNarrow, useWidth, type Item } from './parts';
import './calendar.css';

// the calendar page: the week or the day of query.day, colored by calendar, with the selected event in the details
// panel and the pending proposals as dashed blocks. the page only reads. a proposal is approved through its approval,
// as on the proposals page. the query is the one that calendarHash in ../today/links.ts writes: day, mode and event.

const PATH = 'calendar';

const MODES: Array<{ value: CalendarMode; label: string }> = [
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

// the calendar changes when an approval of a proposal is decided, because the app then creates the event.
const refreshCalendar = (message: StreamMessage) => message.kind === 'approval';

// the clock of the server, which moves on with the clock of the browser, so the now line moves while the page is open.
function useNow(meta: Meta | undefined): number | undefined {
  const [tick, setTick] = useState(() => Date.now());
  const [loaded] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return meta ? Date.parse(meta.now) + (tick - loaded) : undefined;
}

export function CalendarPage({ query }: RouteProps) {
  const meta = useApi<Meta>('/api/meta');
  const now = useNow(meta.data);
  const today = meta.data && now !== undefined ? dayOf(now, meta.data.timeZone) : undefined;
  const asked = query.get('day');
  const day = isDay(asked) ? asked : today;
  const mode: CalendarMode = query.get('mode') === 'day' ? 'day' : 'week';
  const selected = query.get('event');
  const from = day ? (mode === 'week' ? mondayOf(day) : day) : undefined;
  const days = mode === 'week' ? 7 : 1;
  const data = useApi<CalendarData>(from ? `/api/calendar?from=${from}&days=${days}` : null, refreshCalendar);
  const [hidden, toggle] = useHidden();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  // the grid needs room for each day. a narrow screen, or a week that the details panel squeezes, shows the agenda.
  const narrow = useNarrow() || (width !== undefined && (width - 46) / days < MIN_DAY_PX);

  const go = (changes: Record<string, string | null>) => setHashQuery(PATH, query, changes);
  const step = mode === 'week' ? 7 : 1;
  const unit = mode === 'week' ? 'week' : 'day';
  const select = (key: string | null) => go({ event: key });

  const page = data.data;
  const items = page ? itemsOf(page, hidden) : [];
  const marks = page ? marksOf(page) : undefined;
  const failed = page ? page.configured && page.skipped.length > 0 && page.calendars.length === 0 : false;
  // the count is of calendar entries, so one invitation on two calendars counts on each, as google shows it.
  const events = items.reduce((count, each) => count + (each.kind === 'event' ? 1 + each.copies.length : 0), 0);
  const toAnswer = page ? page.invites.length : 0;
  const subtitle = page && page.configured && !failed ? `${events ? plural(events, 'event') : 'No events'}${toAnswer ? ` · ${toAnswer} to answer` : ''}` : undefined;

  const toolbar =
    day && from && page?.configured !== false ? (
      <FilterBar
        label="calendar range"
        end={<Segmented label="view" value={mode} options={MODES} onChange={(next) => go({ mode: next === 'week' ? null : next, day })} />}
      >
        <div className="cal-nav">
          <IconButton icon="chevron-left" label={`Previous ${unit}`} size="sm" onClick={() => go({ day: addDays(day, -step), event: null })} />
          <Button size="sm" onClick={() => go({ day: null, event: null })}>
            Today
          </Button>
          <IconButton icon="chevron-right" label={`Next ${unit}`} size="sm" onClick={() => go({ day: addDays(day, step), event: null })} />
        </div>
        <h2 className="cal-range">{rangeTitle(from, addDays(from, days - 1))}</h2>
      </FilterBar>
    ) : null;

  let body;
  if (meta.error) body = <p className="error-box">Could not load: {meta.error}</p>;
  else if (data.error)
    body = (
      <div className="error-box cal-error" role="alert">
        <p>Could not load the calendar: {data.error}</p>
        <Button size="sm" icon="refresh" onClick={data.reload}>
          Try again
        </Button>
      </div>
    );
  else if (!page || !marks || !today) body = <Skeleton lines={6} label="Loading the calendar…" />;
  else if (!page.configured)
    body = (
      <EmptyState icon="calendar" title="Connect Google to see your calendars" action={<ButtonLink href="#/google" variant="primary">Open the Google page</ButtonLink>}>
        The calendar shows every calendar that you show in Google Calendar, on each account that you connect.
      </EmptyState>
    );
  else if (failed)
    body = (
      <div className="error-box cal-error" role="alert">
        <p>Could not read any calendar.</p>
        <ul className="cal-skipped">
          {page.skipped.map((each) => (
            <li key={each.account}>{each.reason}</li>
          ))}
        </ul>
        <div className="cal-error-actions">
          <Button size="sm" icon="refresh" onClick={data.reload}>
            Try again
          </Button>
          <ButtonLink size="sm" href="#/google">
            Open the Google page
          </ButtonLink>
        </div>
      </div>
    );
  else {
    const empty = !page.events.length && !page.proposals.length;
    body = (
      <>
        {page.skipped.length ? (
          <div className="cal-banner" role="status">
            <p>Some calendars are missing:</p>
            <ul className="cal-skipped">
              {page.skipped.map((each, index) => (
                <li key={`${each.account}/${each.calendarId ?? ''}/${index}`}>{each.reason}</li>
              ))}
            </ul>
            <a href="#/google">Open the Google page</a>
          </div>
        ) : null}
        <Legend calendars={page.calendars} hidden={hidden} onToggle={toggle} />
        {!empty && !narrow ? <MarksKey /> : null}
        {empty ? (
          <EmptyState icon="calendar" title={mode === 'week' ? 'Nothing on the calendar this week.' : 'Nothing on the calendar this day.'} />
        ) : narrow ? (
          <Agenda page={page} items={items} marks={marks} today={today} selected={selected} onSelect={select} />
        ) : (
          <Grid
            page={page}
            items={items}
            marks={marks}
            mode={mode}
            today={today}
            now={now!}
            selected={selected}
            onSelect={select}
            onOpenDay={(next) => go({ day: next, mode: 'day' })}
          />
        )}
      </>
    );
  }

  const chosen: Item | undefined = selected ? items.find((each) => itemIs(each, selected)) : undefined;

  return (
    <Page title="Calendar" subtitle={subtitle} toolbar={toolbar} width="full">
      <div className="cal-page" ref={box}>
        {body}
      </div>
      {selected && page && marks ? (
        chosen ? (
          <DetailsPanel title={chosen.kind === 'event' ? 'Event' : 'Proposal'} openKey={chosen.key} onClose={() => select(null)}>
            {chosen.kind === 'event' ? <EventDetails item={chosen} page={page} marks={marks} /> : <ProposalDetails item={chosen} page={page} onDecided={data.reload} />}
          </DetailsPanel>
        ) : (
          <DetailsPanel title="Calendar" openKey={selected} onClose={() => select(null)}>
            <p className="muted">This event is not in this {unit}, or its calendar is hidden.</p>
          </DetailsPanel>
        )
      ) : null}
    </Page>
  );
}
