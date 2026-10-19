import { useState } from 'react';
import type { AutomationRow, HeartbeatStatus, Overview as OverviewData } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Load, Status } from '../components';
import { bytes, clock, longDay, time, usd } from '../format';
import { ButtonLink, DetailsPanel, EmptyState, Facts, Page, Section, Stat, Stats, Table, type Column } from '../ui';
import './Overview.css';

// the overview is the reference for the restyle of the other pages: a Page with a subtitle, a row of Stats, Sections
// under hairlines, a Table whose selected row opens in the DetailsPanel, and an EmptyState for each empty list.

function HeartbeatFacts({ heartbeat }: { heartbeat: HeartbeatStatus }) {
  const on = Boolean(heartbeat.automation?.enabled);
  return (
    <Facts
      items={[
        {
          label: 'Status',
          value: (
            <>
              <Status value={on ? 'on' : 'off'} /> {on ? `every ${heartbeat.every}` : null}
            </>
          ),
        },
        {
          label: 'Active hours',
          value: `${heartbeat.activeHours.start} to ${heartbeat.activeHours.end}${heartbeat.inActiveHours ? ' (now inside)' : ' (now outside)'}`,
        },
        { label: 'Next check', value: time(heartbeat.automation?.nextRunAt) },
        {
          label: 'Last check',
          value: heartbeat.lastRun ? (
            <>
              <Status value={heartbeat.lastRun.status} /> {time(heartbeat.lastRun.startedAt)}{' '}
              {heartbeat.lastRun.error ? <span className="muted">{heartbeat.lastRun.error}</span> : null}
            </>
          ) : (
            'never'
          ),
        },
        { label: 'Checklist', value: heartbeat.checklist || <span className="muted">empty, so the heartbeat skips</span> },
      ]}
    />
  );
}

function AutomationFacts({ automation }: { automation: AutomationRow }) {
  return (
    <>
      <Facts
        layout="stacked"
        items={[
          { label: 'Schedule', value: automation.schedule },
          { label: 'Next run', value: time(automation.nextRunAt) },
          { label: 'Last run', value: time(automation.lastRunAt) },
          { label: 'State', value: <Status value={automation.enabled ? 'on' : 'off'} /> },
          { label: 'Slot', value: automation.slot },
          { label: 'Made by', value: automation.createdBy },
          automation.consecutiveFailures > 0 && { label: 'Failures in a row', value: automation.consecutiveFailures },
        ]}
      />
      <div>
        <ButtonLink href="#/automations" size="sm" icon="automation">
          Open in Automations
        </ButtonLink>
      </div>
    </>
  );
}

const COLUMNS: Array<Column<AutomationRow>> = [
  { key: 'name', header: 'Name', cell: (automation) => automation.name, wrap: true },
  { key: 'schedule', header: 'Schedule', cell: (automation) => automation.schedule, hideBelow: 'sm' },
  { key: 'next', header: 'Next run', cell: (automation) => time(automation.nextRunAt), align: 'end' },
];

function OverviewBody({ data }: { data: OverviewData }) {
  const [selected, setSelected] = useState<string | null>(null);
  const automation = data.nextAutomations.find((each) => each.id === selected);
  return (
    <>
      <Stats label="today">
        <Stat label="Cost today" value={usd(data.costUsd)} note={data.day} />
        <Stat label="Runs today" value={data.runs} />
        <Stat label="Errors today" value={data.failedRuns + data.modelErrors} note={`${data.failedRuns} failed runs, ${data.modelErrors} failed model calls`} />
        <Stat label="Open goals" value={data.openGoals.length} />
        <Stat label="Blob store" value={bytes(data.blobs.bytes)} note={`${data.blobs.count} blobs`} />
      </Stats>
      <div className="columns">
        <Section title="Open goals today" actions={<a href="#/goals">All goals</a>}>
          {data.openGoals.length ? (
            <ul className="overview-goals">
              {data.openGoals.map((goal) => (
                <li key={goal.id}>
                  <span className="overview-goal-id">#{goal.id}</span>
                  <span className="overview-goal-title">{goal.title}</span>
                  {goal.eta ? <span className="muted">eta {clock(goal.eta)}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="goal" title="No open goals today." />
          )}
        </Section>
        <Section title="Heartbeat">
          <HeartbeatFacts heartbeat={data.heartbeat} />
        </Section>
      </div>
      <Section title="Next automations" description="Select one to see its details.">
        <Table
          label="next automations"
          columns={COLUMNS}
          rows={data.nextAutomations}
          rowKey={(each) => each.id}
          selected={selected}
          onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
          empty={<EmptyState icon="automation" title="No automation is planned." />}
        />
      </Section>
      {automation ? (
        <DetailsPanel title={automation.name} openKey={automation.id} onClose={() => setSelected(null)}>
          <AutomationFacts automation={automation} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Today">
          <Facts
            layout="stacked"
            items={[
              { label: 'Day', value: data.day },
              { label: 'Failed runs', value: data.failedRuns },
              { label: 'Failed model calls', value: data.modelErrors },
              { label: 'Next automation', value: data.nextAutomations[0] ? `${data.nextAutomations[0].name}, ${time(data.nextAutomations[0].nextRunAt)}` : 'none' },
            ]}
          />
        </DetailsPanel>
      )}
    </>
  );
}

export function Overview() {
  const loaded = useApi<OverviewData>('/api/overview', (message) => message.kind === 'run');
  return (
    <Page title="Overview" subtitle={loaded.data ? longDay(loaded.data.day) : undefined}>
      <Load loaded={loaded}>{(data) => <OverviewBody data={data} />}</Load>
    </Page>
  );
}
