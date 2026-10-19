import type { CostGroup, CostPage } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { BarChart, Load } from '../components';
import { shortDay, tokens, usd } from '../format';
import type { RouteProps } from '../routes';
import { DetailsPanel, EmptyState, Facts, Page, Section, Stat, Stats, Table, type Column } from '../ui';
import './dev.css';

function columns(name: string): Array<Column<CostGroup>> {
  return [
    { key: 'key', header: name, cell: (group) => <span className="cost-key">{group.key}</span>, wrap: true },
    { key: 'cost', header: 'Cost', cell: (group) => usd(group.costUsd), align: 'end' },
    { key: 'calls', header: 'Calls', cell: (group) => group.calls, align: 'end' },
    { key: 'input', header: 'Input tokens', cell: (group) => tokens(group.inputTokens), align: 'end', hideBelow: 'sm' },
    { key: 'cache', header: 'Cache read', cell: (group) => tokens(group.cacheReadTokens), align: 'end', hideBelow: 'md' },
    { key: 'output', header: 'Output tokens', cell: (group) => tokens(group.outputTokens), align: 'end', hideBelow: 'sm' },
  ];
}

function GroupTable({ name, groups }: { name: string; groups: CostGroup[] }) {
  return (
    <Table
      label={`cost by ${name.toLowerCase()}`}
      dense
      columns={columns(name)}
      rows={groups}
      rowKey={(group) => group.key}
      empty={<EmptyState icon="cost" title="No model calls in these days." />}
    />
  );
}

function CostBody({ page }: { page: CostPage }) {
  const total = page.days.reduce((sum, day) => sum + day.costUsd, 0);
  const calls = page.days.reduce((sum, day) => sum + day.calls, 0);
  const busiest = page.days.reduce<CostGroup | undefined>((top, day) => (!top || day.costUsd > top.costUsd ? day : top), undefined);
  return (
    <>
      <Stats label="cost">
        <Stat label="Today" value={usd(page.days.at(-1)?.costUsd ?? 0)} />
        <Stat
          label="Last 30 days"
          value={usd(total)}
          note={
            <>
              <span className="cost-day">{page.from}</span> to <span className="cost-day">{page.to}</span>
            </>
          }
        />
        <Stat label="Model calls, 30 days" value={calls} />
        <Stat label="Calls without a price" value={page.unpricedCalls} note="their cost is not in the totals" />
      </Stats>
      <Section title="Cost by day" description="One bar for each day. Hover a bar for its cost and calls.">
        <BarChart
          format={(value) => usd(value)}
          bars={page.days.map((day) => ({
            label: shortDay(day.key),
            value: day.costUsd,
            title: `${day.key}: ${usd(day.costUsd)} in ${day.calls} calls`,
          }))}
        />
      </Section>
      <div className="cost-columns">
        <Section title="By slot">
          <GroupTable name="Slot" groups={page.slots} />
        </Section>
        <Section title="By model">
          <GroupTable name="Model" groups={page.models} />
        </Section>
      </div>
      <Section title="By day" description="The days with model calls, newest first.">
        <GroupTable name="Day" groups={[...page.days].reverse().filter((day) => day.calls)} />
      </Section>
      {/* the panel names no model, because the model table already does. */}
      <DetailsPanel title="Period">
        <Facts
          layout="stacked"
          items={[
            { label: 'From', value: page.from },
            { label: 'To', value: page.to },
            { label: 'Days with calls', value: page.days.filter((day) => day.calls).length },
            busiest && busiest.costUsd > 0 && { label: 'Most expensive day', value: `${busiest.key}, ${usd(busiest.costUsd)}` },
            { label: 'Average per day', value: usd(page.days.length ? total / page.days.length : 0) },
          ]}
        />
        <p className="muted small">A call of a model without a price has no cost, so the totals leave it out.</p>
      </DetailsPanel>
    </>
  );
}

export function Cost(_props: Partial<RouteProps>) {
  const loaded = useApi<CostPage>('/api/cost', (message) => message.kind === 'run' && message.run.status !== 'running');
  return (
    <Page title="Cost" subtitle="The cost of the model calls of the last 30 days." width="full">
      <Load loaded={loaded}>{(page) => <CostBody page={page} />}</Load>
    </Page>
  );
}
