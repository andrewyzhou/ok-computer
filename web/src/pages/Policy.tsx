import { useState } from 'react';
import type { PolicyPage } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Empty, Load, Page, Panel, Status } from '../components';
import { time } from '../format';
import { sessionHref } from './Runs';

const DECISIONS = ['allow', 'review', 'approve', 'deny'];
const VERDICTS = ['allow', 'hold'];

export function Policy() {
  const [filter, setFilter] = useState({ decision: '', verdict: '' });
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  const loaded = useApi<PolicyPage>(`/api/policy${query ? `?${query}` : ''}`, (message) => message.kind === 'run');
  const select = (key: 'decision' | 'verdict', options: string[]) => (
    <label>
      {key}
      <select value={filter[key]} onChange={(event) => setFilter({ ...filter, [key]: event.target.value })}>
        <option value="">all</option>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
  return (
    <Page title="Policy">
      <div className="filters">
        {select('decision', DECISIONS)}
        {select('verdict', VERDICTS)}
      </div>
      <Load loaded={loaded}>
        {(page) => (
          <>
            <Panel title="Recent decisions">
              {page.decisions.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Tool</th>
                      <th>Decision</th>
                      <th>Rule</th>
                      <th>Reason</th>
                      <th>Session</th>
                      <th>Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.decisions.map((row) => (
                      <tr key={row.id}>
                        <td>{time(row.createdAt)}</td>
                        <td>{row.toolName}</td>
                        <td>
                          <Status value={row.decision} /> {row.reviewerVerdict ? <Status value={row.reviewerVerdict} /> : null}{' '}
                          {row.approvalStatus ? <Status value={row.approvalStatus} /> : null}
                        </td>
                        <td>
                          <code>{row.rule}</code>
                        </td>
                        <td className="wrap">
                          {row.reason}
                          {row.reviewerReason ? <div className="muted">reviewer: {row.reviewerReason}</div> : null}
                        </td>
                        <td>
                          <a href={sessionHref(row.sessionKey)}>{row.sessionKey}</a>
                        </td>
                        <td>
                          <a href={`#/runs/${encodeURIComponent(row.runId)}`}>{row.runId.slice(0, 8)}</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No policy decision matches.</Empty>
              )}
            </Panel>
            <Panel title="Rules">
              <p className="muted">The built-in rules, then the rules of okc.policy.json. A deny rule always wins.</p>
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Tool</th>
                    <th>Session</th>
                    <th>Args</th>
                    <th>Effect</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rules.map((rule) => (
                    <tr key={rule.id}>
                      <td>
                        <code>{rule.id}</code>
                      </td>
                      <td>{rule.tool}</td>
                      <td>{rule.session ?? ''}</td>
                      <td>{rule.args ? <code>{JSON.stringify(rule.args)}</code> : ''}</td>
                      <td>
                        <Status value={rule.effect} />
                      </td>
                      <td className="wrap">{rule.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}
