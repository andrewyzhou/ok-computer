import { useState } from 'react';
import type { GoalRow, GoalsPage } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { BarChart, Load } from '../components';
import { clock, longDay, percent, shortDay, time } from '../format';
import { DetailsPanel, EmptyState, Facts, Page, Section, Stat, Stats, Status } from '../ui';
import './agent.css';

// a streak on a day counts the days with goals up to that day. the server gives the streak of the last day only.
function streaks(days: GoalsPage['days']): number[] {
  let run = 0;
  return days.map((day) => (run = day.goals ? run + 1 : 0));
}

// each goal is a button, so the keyboard reaches it and a tap on a phone opens its details.
function GoalList({
  goals,
  selected,
  onSelect,
  label,
}: {
  goals: GoalRow[];
  selected: number | null;
  onSelect: (goal: GoalRow) => void;
  label: string;
}) {
  return (
    <ul className="goals-list" aria-label={label}>
      {goals.map((goal) => (
        <li key={goal.id}>
          <button
            type="button"
            className={goal.id === selected ? 'goals-item is-selected' : 'goals-item'}
            aria-pressed={goal.id === selected}
            onClick={() => onSelect(goal)}
          >
            <Status value={goal.status} />
            <span className="goals-id">#{goal.id}</span>
            <span className="goals-title">{goal.title}</span>
            {goal.eta ? <span className="goals-meta">eta {clock(goal.eta)}</span> : null}
            {goal.note ? <span className="goals-meta goals-note">{goal.note}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function GoalsBody({ page }: { page: GoalsPage }) {
  const [selected, setSelected] = useState<number | null>(null);
  const select = (goal: GoalRow) => setSelected(goal.id === selected ? null : goal.id);
  const today = page.goals.filter((goal) => goal.day === page.today);
  const earlier = [...new Set(page.goals.map((goal) => goal.day))]
    .filter((day) => day !== page.today)
    .sort()
    .reverse();
  const streak = streaks(page.days);
  const goal = page.goals.find((each) => each.id === selected);
  return (
    <>
      <Stats label="goal stats">
        <Stat label="Hit rate, 7 days" value={percent(page.stats7.hitRate)} note={`${page.stats7.done} of ${page.stats7.goals} done`} />
        <Stat label="Hit rate, 30 days" value={percent(page.stats30.hitRate)} note={`${page.stats30.doneOnTime} done on time`} />
        <Stat label="Days with goals in a row" value={page.stats30.setStreak} />
        <Stat label="Days with all goals done in a row" value={page.stats30.allDoneStreak} />
      </Stats>
      <Section title={`Today, ${page.today}`}>
        {today.length ? (
          <GoalList goals={today} selected={selected} onSelect={select} label="goals today" />
        ) : (
          <EmptyState icon="goal" title="No goals set today." />
        )}
      </Section>
      <div className="columns">
        <Section title="Daily hit rate, last 30 days">
          <BarChart
            max={1}
            format={(value) => percent(value)}
            bars={page.days.map((day) => ({
              label: shortDay(day.day),
              value: day.goals ? day.done / day.goals : 0,
              title: `${day.day}: ${day.done} of ${day.goals} goals done`,
            }))}
          />
        </Section>
        <Section title="Streak of days with goals">
          <BarChart
            format={(value) => String(Math.round(value))}
            bars={page.days.map((day, i) => ({
              label: shortDay(day.day),
              value: streak[i]!,
              title: `${day.day}: streak of ${streak[i]} days`,
            }))}
          />
        </Section>
      </div>
      <Section title="History">
        {earlier.length ? (
          earlier.map((day) => (
            <div key={day} className="goals-day">
              <h3 className="goals-day-title">{day}</h3>
              <GoalList
                goals={page.goals.filter((each) => each.day === day)}
                selected={selected}
                onSelect={select}
                label={`goals of ${day}`}
              />
            </div>
          ))
        ) : (
          <EmptyState icon="goal" title="No goals in the last 30 days before today." />
        )}
      </Section>
      {goal ? (
        <DetailsPanel title={goal.title} openKey={goal.id} onClose={() => setSelected(null)}>
          <Facts
            layout="stacked"
            items={[
              { label: 'Status', value: <Status value={goal.status} /> },
              { label: 'Goal', value: `#${goal.id}` },
              { label: 'Day', value: longDay(goal.day) },
              { label: 'Eta', value: goal.eta ? clock(goal.eta) : 'none' },
              {
                label: 'Completed',
                value: goal.completedAt ? time(goal.completedAt) : 'not yet',
              },
              {
                label: 'Note',
                value: goal.note ?? <span className="muted">no note</span>,
              },
            ]}
          />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Today">
          <Facts
            layout="stacked"
            items={[
              { label: 'Goals today', value: today.length },
              {
                label: 'Done today',
                value: today.filter((each) => each.status === 'done').length,
              },
              {
                label: 'Open today',
                value: today.filter((each) => each.status === 'open').length,
              },
            ]}
          />
          <p className="muted small">Select a goal to see its details.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Goals() {
  const loaded = useApi<GoalsPage>('/api/goals', (message) => message.kind === 'run');
  return (
    <Page title="Goals" subtitle={loaded.data ? longDay(loaded.data.today) : undefined}>
      <Load loaded={loaded}>{(page) => <GoalsBody page={page} />}</Load>
    </Page>
  );
}
