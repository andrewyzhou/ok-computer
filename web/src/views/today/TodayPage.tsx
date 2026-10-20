import { useEffect, useState, type ReactNode } from 'react';
import type { Brief, BriefSchedule, BriefsPage } from '../../../../src/dashboard/brief-types';
import type { Meta, StreamMessage } from '../../../../src/dashboard/types';
import { api, send, useApi } from '../../api';
import { longDay } from '../../format';
import { Icon } from '../../icons';
import type { RouteProps } from '../../routes';
import { Button, ButtonLink, EmptyState, isNotFound, Page, Skeleton } from '../../ui';
import { calendarHash } from './links';
import { addDays, BriefSections, Delivery, findItem, isDay, ItemDetails, localDay, ScheduleLine, SourcesStrip } from './parts';
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

  const runButton = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} size="sm" icon="refresh" title="Make a brief now" busy={run.phase === 'busy' || run.phase === 'building'} onClick={runNow}>
      {variant === 'secondary' ? <span className="today-action-label">Make a brief now</span> : 'Make a brief now'}
    </Button>
  );

  // the labels of the header actions fold on a narrow screen, so the header keeps the icons. a screen reader still
  // hears each label.
  const actions = valid ? (
    <>
      {runButton('secondary')}
      <ButtonLink href={calendarHash(day)} size="sm" variant="ghost" icon="calendar" title="Calendar">
        <span className="today-action-label">Calendar</span>
      </ButtonLink>
    </>
  ) : undefined;

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
  const sections = data?.content.sections ?? [];

  return (
    // the empty crumbs keep the header at the name of the group, for today and for each day.
    <Page title="Today" crumbs={[]} subtitle={longDay(day)} actions={actions}>
      <div className="today-page">
        <div className="today-bar">
          <DayNav day={day} today={today} />
          <ScheduleLine schedule={scheduleData} error={schedule.error} timeZone={timeZone} onSaved={schedule.reload} />
        </div>
        <RunNote run={run} />
        {missing ? (
          <EmptyMissing day={day} today={today} first={first} schedule={scheduleData} button={runButton('primary')} />
        ) : brief.error ? (
          <div className="error-box today-error" role="alert">
            <span>Could not load the brief: {brief.error}</span>
            <Button size="sm" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : data ? (
          <>
            <SourcesStrip sources={data.content.sources} />
            <BriefSections sections={sections} selectedId={selectedKey} onSelect={(key) => setSelection({ day, key })} />
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

// a day with no brief: the first run, a day whose brief comes later, a day that had none, or a brief that is off.
function EmptyMissing({ day, today, first, schedule, button }: { day: string; today: string; first: boolean; schedule: BriefSchedule | undefined; button: ReactNode }) {
  const on = schedule?.enabled === true && schedule.time !== null;
  if (on && first) return <EmptyState icon="today" title={`Your first brief comes at ${schedule.time}.`} action={button}>The brief reads your calendars, the inbox digest and your goals each morning, and sends a short message with a link here.</EmptyState>;
  if (on && day >= today) return <EmptyState icon="today" title={`The brief of ${longDay(day)} comes at ${schedule.time}.`} action={button} />;
  if (schedule && !schedule.enabled && day >= today)
    return (
      <EmptyState icon="today" title="The brief is off." action={button}>
        Change its time above to turn it on.
      </EmptyState>
    );
  return <EmptyState icon="today" title={`There is no brief for ${longDay(day)}.`} action={day === today ? button : undefined} />;
}
