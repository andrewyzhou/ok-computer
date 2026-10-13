import type { CostGroup, CostPage } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { BarChart, Load, Page, Panel, Tile } from '../components';
import { shortDay, tokens, usd } from '../format';

function GroupTable({ name, groups }: { name: string; groups: CostGroup[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{name}</th>
          <th className="num">Cost</th>
          <th className="num">Calls</th>
          <th className="num">Input tokens</th>
          <th className="num">Cache read</th>
          <th className="num">Output tokens</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.key}>
            <td>{group.key}</td>
            <td className="num">{usd(group.costUsd)}</td>
            <td className="num">{group.calls}</td>
            <td className="num">{tokens(group.inputTokens)}</td>
            <td className="num">{tokens(group.cacheReadTokens)}</td>
            <td className="num">{tokens(group.outputTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Cost() {
  const loaded = useApi<CostPage>('/api/cost', (message) => message.kind === 'run' && message.run.status !== 'running');
  return (
    <Page title="Cost">
      <Load loaded={loaded}>
        {(page) => {
          const total = page.days.reduce((sum, day) => sum + day.costUsd, 0);
          const calls = page.days.reduce((sum, day) => sum + day.calls, 0);
          return (
            <>
              <div className="tiles">
                <Tile label="Today" value={usd(page.days.at(-1)?.costUsd ?? 0)} />
                <Tile label="Last 30 days" value={usd(total)} note={`${page.from} to ${page.to}`} />
                <Tile label="Model calls, 30 days" value={calls} />
                <Tile label="Calls without a price" value={page.unpricedCalls} note="their cost is not in the totals" />
              </div>
              <Panel title="Cost by day">
                <BarChart
                  format={(value) => usd(value)}
                  bars={page.days.map((day) => ({
                    label: shortDay(day.key),
                    value: day.costUsd,
                    title: `${day.key}: ${usd(day.costUsd)} in ${day.calls} calls`,
                  }))}
                />
              </Panel>
              <div className="columns">
                <Panel title="By slot">
                  <GroupTable name="Slot" groups={page.slots} />
                </Panel>
                <Panel title="By model">
                  <GroupTable name="Model" groups={page.models} />
                </Panel>
              </div>
              <Panel title="By day">
                <GroupTable name="Day" groups={[...page.days].reverse().filter((day) => day.calls)} />
              </Panel>
            </>
          );
        }}
      </Load>
    </Page>
  );
}
