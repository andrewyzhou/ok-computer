import type { Overview as OverviewData } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Empty, Load, Page, Panel, Status, Tile } from '../components';
import { clock, time, usd } from '../format';

export function Overview() {
  const loaded = useApi<OverviewData>('/api/overview', (message) => message.kind === 'run');
  return (
    <Page title="Overview">
      <Load loaded={loaded}>
        {(data) => (
          <>
            <div className="tiles">
              <Tile label="Cost today" value={usd(data.costUsd)} note={data.day} />
              <Tile label="Runs today" value={data.runs} />
              <Tile
                label="Errors today"
                value={data.failedRuns + data.modelErrors}
                note={`${data.failedRuns} failed runs, ${data.modelErrors} failed model calls`}
              />
              <Tile label="Open goals" value={data.openGoals.length} />
            </div>
            <div className="columns">
              <Panel title="Open goals today">
                {data.openGoals.length ? (
                  <ul className="list">
                    {data.openGoals.map((goal) => (
                      <li key={goal.id}>
                        #{goal.id} {goal.title} {goal.eta ? <span className="muted">eta {clock(goal.eta)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No open goals today.</Empty>
                )}
              </Panel>
              <Panel title="Heartbeat">
                <dl className="facts">
                  <dt>Status</dt>
                  <dd>
                    <Status value={data.heartbeat.automation?.enabled ? 'on' : 'off'} />{' '}
                    {data.heartbeat.automation?.enabled ? `every ${data.heartbeat.every}` : null}
                  </dd>
                  <dt>Active hours</dt>
                  <dd>
                    {data.heartbeat.activeHours.start} to {data.heartbeat.activeHours.end}
                    {data.heartbeat.inActiveHours ? ' (now inside)' : ' (now outside)'}
                  </dd>
                  <dt>Next check</dt>
                  <dd>{time(data.heartbeat.automation?.nextRunAt)}</dd>
                  <dt>Last check</dt>
                  <dd>
                    {data.heartbeat.lastRun ? (
                      <>
                        <Status value={data.heartbeat.lastRun.status} /> {time(data.heartbeat.lastRun.startedAt)}{' '}
                        {data.heartbeat.lastRun.error ? <span className="muted">{data.heartbeat.lastRun.error}</span> : null}
                      </>
                    ) : (
                      'never'
                    )}
                  </dd>
                  <dt>Checklist</dt>
                  <dd>{data.heartbeat.checklist || <span className="muted">empty, so the heartbeat skips</span>}</dd>
                </dl>
              </Panel>
            </div>
            <Panel title="Next automations">
              {data.nextAutomations.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Schedule</th>
                      <th>Next run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.nextAutomations.map((automation) => (
                      <tr key={automation.id}>
                        <td>{automation.name}</td>
                        <td>{automation.schedule}</td>
                        <td>{time(automation.nextRunAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No automation is planned.</Empty>
              )}
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}
