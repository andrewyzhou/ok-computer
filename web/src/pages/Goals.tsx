import type { GoalRow, GoalsPage } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { BarChart, Empty, Load, Page, Panel, Status, Tile } from '../components';
import { clock, percent, shortDay } from '../format';

// a streak on a day counts the days with goals up to that day. the server gives the streak of the last day only.
function streaks(days: GoalsPage['days']): number[] {
  let run = 0;
  return days.map((day) => (run = day.goals ? run + 1 : 0));
}

function GoalList({ goals }: { goals: GoalRow[] }) {
  return (
    <ul className="list">
      {goals.map((goal) => (
        <li key={goal.id}>
          <Status value={goal.status} /> #{goal.id} {goal.title}
          {goal.eta ? <span className="muted"> · eta {clock(goal.eta)}</span> : null}
          {goal.note ? <span className="muted"> · {goal.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function Goals() {
  const loaded = useApi<GoalsPage>('/api/goals', (message) => message.kind === 'run');
  return (
    <Page title="Goals">
      <Load loaded={loaded}>
        {(page) => {
          const today = page.goals.filter((goal) => goal.day === page.today);
          const earlier = [...new Set(page.goals.map((goal) => goal.day))].filter((day) => day !== page.today).sort().reverse();
          const streak = streaks(page.days);
          return (
            <>
              <div className="tiles">
                <Tile label="Hit rate, 7 days" value={percent(page.stats7.hitRate)} note={`${page.stats7.done} of ${page.stats7.goals} done`} />
                <Tile label="Hit rate, 30 days" value={percent(page.stats30.hitRate)} note={`${page.stats30.doneOnTime} done on time`} />
                <Tile label="Days with goals in a row" value={page.stats30.setStreak} />
                <Tile label="Days with all goals done in a row" value={page.stats30.allDoneStreak} />
              </div>
              <Panel title={`Today, ${page.today}`}>{today.length ? <GoalList goals={today} /> : <Empty>No goals set today.</Empty>}</Panel>
              <div className="columns">
                <Panel title="Daily hit rate, last 30 days">
                  <BarChart
                    max={1}
                    format={(value) => percent(value)}
                    bars={page.days.map((day) => ({
                      label: shortDay(day.day),
                      value: day.goals ? day.done / day.goals : 0,
                      title: `${day.day}: ${day.done} of ${day.goals} goals done`,
                    }))}
                  />
                </Panel>
                <Panel title="Streak of days with goals">
                  <BarChart
                    format={(value) => String(Math.round(value))}
                    bars={page.days.map((day, i) => ({
                      label: shortDay(day.day),
                      value: streak[i]!,
                      title: `${day.day}: streak of ${streak[i]} days`,
                    }))}
                  />
                </Panel>
              </div>
              <Panel title="History">
                {earlier.length ? (
                  earlier.map((day) => (
                    <div key={day} className="day">
                      <h3>{day}</h3>
                      <GoalList goals={page.goals.filter((goal) => goal.day === day)} />
                    </div>
                  ))
                ) : (
                  <Empty>No goals in the last 30 days before today.</Empty>
                )}
              </Panel>
            </>
          );
        }}
      </Load>
    </Page>
  );
}
