import { useEffect, useState, type ReactNode } from 'react';
import type { Brief, BriefSchedule, BriefsPage } from '../../../../src/dashboard/brief-types';
import type { Meta, StreamMessage } from '../../../../src/dashboard/types';
import { api, send, useApi } from '../../api';
import { longDay } from '../../format';
import { Icon } from '../../icons';
import type { RouteProps } from '../../routes';
import { Button, ButtonLink, EmptyState, isNotFound, Page, Skeleton } from '../../ui';
import { calendarHash } from './links';
import { addDays, BriefSections, Delivery, DeliveryAlert, findItem, isDay, ItemDetails, localDay, ScheduleLine, shortDate, sourceNotes, SourcesStrip } from './parts';
import './today.css';

// the today page: the stored brief of a day (params.day, or the local today), with each item linked to its source.
// the routes give today and today/:day one page key, so a new day changes the page in place and the page keeps its
// state, except the selection, which belongs to its day.

// a run that ends can be the brief, so the page loads again.
const refreshOnRun = (message: StreamMessage) => message.kind === 'run';

// after a start the page asks again every 3 seconds, at most 10 times, in case the stream is down.
const POLL_MS = 3000;
const POLLS = 10;

type RunState = { phase: 'idle' } | { phase: 'busy' } | { phase: 'building'; day: string; baseline: number | null; polls: number } | { phase: 'late' } | { phase: 'failed'; error: string };

function DayNav({ day, today }: { day: string; today: string }) {
  const go = (next: string) => {
    location.hash = `#/today/${next}`;
  };
  return (
    <nav className="today-daynav" aria-label="days">
      <Button size="sm" variant="ghost" icon="chevron-left" onClick={() => go(addDays(day, -1))}>
        Previous day
      </Button>
      <Button size="sm" variant={day === today ? 'ghost' : 'secondary'} disabled={day === today} onClick={() => go(today)}>
        Today
      </Button>
      <Button size="sm" variant="ghost" onClick={() => go(addDays(day, 1))}>
        Next day
        <Icon name="chevron-right" size={14} />
      </Button>
    </nav>
  );
}

export function TodayPage({ params }: RouteProps) {
  const meta = useApi<Meta>('/api/meta');
  const timeZone = meta.data?.timeZone ?? 'UTC';
  const today = meta.data ? localDay(meta.data.now, timeZone) : null;
  const day = params.day ?? today;
  const valid = day !== null && isDay(day);
  const brief = useApi<Brief>(valid ? `/api/briefs/day/${day}` : null, refreshOnRun);
  const schedule = useApi<BriefSchedule>('/api/brief/schedule', refreshOnRun);
  const missing = brief.error !== undefined && isNotFound(brief.error);
  // the list tells a first run from a day that has no brief yet. it loads only for a missing brief.
  const list = useApi<BriefsPage>(missing ? '/api/briefs?limit=1' : null);
  const [selection, setSelection] = useState<{ day: string | null; key: string | null }>({ day: null, key: null });
  const selectedKey = selection.day === day ? selection.key : null;
  const [run, setRun] = useState<RunState>({ phase: 'idle' });

  const reload = () => {
    brief.reload();
    schedule.reload();
  };

  // a building brief is done when the brief of its day is a new row.
  const briefId = brief.data?.id ?? null;
  const briefDay = brief.data?.day ?? null;
  useEffect(() => {
    if (run.phase === 'building' && briefDay === run.day && briefId !== null && briefId !== run.baseline) setRun({ phase: 'idle' });
  }, [run, briefId, briefDay]);

  // the reload functions are new on each render, so only a new poll starts a new wait.
  useEffect(() => {
    if (run.phase !== 'building') return;
    const timer = setTimeout(() => {
      if (run.polls + 1 >= POLLS) setRun({ phase: 'late' });
      else setRun({ ...run, polls: run.polls + 1 });
      brief.reload();
      schedule.reload();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [run]);

  // the brief that a run makes is the brief of today, so the page goes to today while it waits. the page knows the
  // brief of today first, so the old row does not count as the new one.
  const runNow = () => {
    if (today === null) return;
    setRun({ phase: 'busy' });
    const baseline: Promise<number | null> =
      day === today && brief.data ? Promise.resolve(brief.data.id) : api<Brief>(`/api/briefs/day/${today}`).then((each) => each.id, () => null);
    void baseline.then((id) =>
      send<{ started: boolean }>('/api/brief/run', 'POST', {}).then(
        () => {
          setRun({ phase: 'building', day: today, baseline: id, polls: 0 });
          if (day !== today) location.hash = `#/today/${today}`;
        },
        (err: Error) => setRun({ phase: 'failed', error: err.message }),
      ),
    );
  };

  // on a narrow screen the header button says "Brief now", so it does not read as a reload of the page. a screen
  // reader hears the whole label.
  const runButton = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} size="sm" icon="refresh" aria-label="Make a brief now" busy={run.phase === 'busy' || run.phase === 'building'} onClick={runNow}>
      {variant === 'secondary' ? (
        <>
          <span className="today-label-long" aria-hidden="true">
            Make a brief now
          </span>
          <span className="today-label-short" aria-hidden="true">
            Brief now
          </span>
        </>
      ) : (
        'Make a brief now'
      )}
    </Button>
  );

  const actions = valid ? (
    <>
      {runButton('secondary')}
      <ButtonLink href={calendarHash(day)} size="sm" variant="ghost" icon="calendar">
        Calendar
      </ButtonLink>
    </>
  ) : undefined;

  // the page is today in the nav and the crumbs, so it keeps that title on each day, and the subtitle names the day.
  const title = 'Today';
  if (meta.error) return <Page title="Today" crumbs={[]}><p className="error-box">Could not load: {meta.error}</p></Page>;
  if (day === null || today === null) return <Page title="Today" crumbs={[]}><Skeleton lines={6} /></Page>;
  if (!valid)
    return (
      <Page title="Today" crumbs={[]}>
        <EmptyState icon="today" title="This is not a day of the calendar.">
          <a href="#/today">Go to today</a>
        </EmptyState>
      </Page>
    );

  const data = brief.data;
  const scheduleData = schedule.data;
  const first = list.data ? list.data.briefs.length === 0 : list.error !== undefined;
  const latest = list.data?.briefs[0]?.day ?? null;
  const sections = data?.content.sections ?? [];

  return (
    // the empty crumbs keep the header at the name of the group, for today and for each day.
    <Page title={title} crumbs={[]} subtitle={longDay(day)} actions={actions}>
      <div className="today-page">
        <div className="today-bar">
          <DayNav day={day} today={today} />
          {schedule.error ? null : <ScheduleLine schedule={scheduleData} timeZone={timeZone} onSaved={schedule.reload} />}
        </div>
        {schedule.error ? (
          <div className="error-box today-error" role="alert">
            <span>Could not load the time of the brief: {schedule.error}</span>
            <Button size="sm" icon="refresh" onClick={schedule.reload}>
              Try again
            </Button>
          </div>
        ) : null}
        <RunNote run={run} />
        {missing ? (
          <EmptyMissing day={day} today={today} first={first} latest={latest} schedule={scheduleData} timeZone={timeZone} button={runButton('primary')} />
        ) : brief.error ? (
          <div className="error-box today-error" role="alert">
            <span>Could not load the brief: {brief.error}</span>
            <span className="today-error-actions">
              <Button size="sm" icon="refresh" onClick={reload}>
                Try again
              </Button>
              {day === today ? (
                <Button size="sm" variant="ghost" busy={run.phase === 'busy' || run.phase === 'building'} onClick={runNow}>
                  Make a brief now
                </Button>
              ) : null}
            </span>
          </div>
        ) : data ? (
          <>
            <DeliveryAlert brief={data} />
            <SourcesStrip sources={data.content.sources} />
            <BriefSections
              sections={sections}
              strip={sourceNotes(data.content.sources).map((note) => note.text)}
              selectedId={selectedKey}
              onSelect={(key) => setSelection({ day, key })}
            />
            <Delivery brief={data} />
          </>
        ) : (
          <Skeleton lines={6} />
        )}
      </div>
      <ItemDetails item={findItem(sections, selectedKey)} timeZone={timeZone} onClose={() => setSelection({ day, key: null })} />
    </Page>
  );
}

function RunNote({ run }: { run: RunState }) {
  if (run.phase === 'building')
    return (
      <p role="status" className="today-note">
        Building the brief…
      </p>
    );
  if (run.phase === 'late')
    return (
      <p role="status" className="today-note">
        The brief is not ready yet. It shows here when it is.
      </p>
    );
  if (run.phase === 'failed')
    return (
      <p role="alert" className="today-note error-text">
        {run.error}
      </p>
    );
  return null;
}

// the words for the day of the next run, seen from today: today, tomorrow, or a short date.
function runDay(next: string, today: string, timeZone: string, nextRunAt: string): string {
  if (next === today) return 'today';
  if (next === addDays(today, 1)) return 'tomorrow';
  return `on ${shortDate(nextRunAt, timeZone)}`;
}

// a day with no brief: the first run, a day whose brief comes later, today when its run already passed, a day that had
// none, or a brief that is off. the next run of the automation decides what the page promises, so it never says that
// a brief comes today when the run of today is over.
function EmptyMissing({
  day,
  today,
  first,
  latest,
  schedule,
  timeZone,
  button,
}: {
  day: string;
  today: string;
  first: boolean;
  latest: string | null;
  schedule: BriefSchedule | undefined;
  timeZone: string;
  button: ReactNode;
}) {
  const on = schedule?.enabled === true && schedule.time !== null;
  const next = on && schedule.nextRunAt ? localDay(schedule.nextRunAt, timeZone) : null;
  const when = on && next && schedule.nextRunAt ? `${runDay(next, today, timeZone, schedule.nextRunAt)} at ${schedule.time}` : on ? `at ${schedule.time}` : null;
  const back = latest && latest !== day ? <a href={`#/today/${latest}`}>Open the latest brief</a> : null;
  if (on && first)
    return (
      <EmptyState icon="today" title={`Your first brief comes ${when}.`} action={button}>
        The brief reads your calendars, the inbox digest and your goals each morning, and sends a short message with a link here.
      </EmptyState>
    );
  // the run of today is over when the next run is on a later day.
  if (on && day === today && next !== null && next > today)
    return (
      <EmptyState icon="today" title="The brief of today did not run." action={button}>
        It was due at {schedule.time}. Make one now, or wait for the next one {when}.
      </EmptyState>
    );
  if (on && day >= today) return <EmptyState icon="today" title={`The brief of ${longDay(day)} comes at ${schedule.time}.`} action={button} />;
  if (schedule && !schedule.enabled && day >= today)
    return (
      <EmptyState icon="today" title="The brief is off." action={button}>
        Use Turn on above to start it.
      </EmptyState>
    );
  return (
    <EmptyState icon="today" title={`There is no brief for ${longDay(day)}.`} action={day === today ? button : undefined}>
      {back ?? (day !== today ? <a href="#/today">Go to today</a> : null)}
    </EmptyState>
  );
}
