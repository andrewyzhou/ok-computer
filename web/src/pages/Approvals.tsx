import { useState } from 'react';
import type { ApprovalRow } from '../../../src/dashboard/types';
import { send, useApi } from '../api';
import { Empty, Load, Page, Panel, Status } from '../components';
import { time } from '../format';

export function Approvals() {
  const loaded = useApi<ApprovalRow[]>('/api/approvals', (message) => message.kind === 'run');
  const [notice, setNotice] = useState('');
  const decide = (id: number, decision: 'approve' | 'deny') =>
    send<{ message: string }>(`/api/approvals/${id}`, 'POST', { decision }).then(
      (result) => {
        setNotice(result.message);
        loaded.reload();
      },
      (err: Error) => setNotice(err.message),
    );
  return (
    <Page title="Approvals" actions={<span className="muted">{notice}</span>}>
      <Load loaded={loaded}>
        {(approvals) => {
          const pending = approvals.filter((approval) => approval.status === 'pending');
          const history = approvals.filter((approval) => approval.status !== 'pending');
          return (
            <>
              <Panel title="Pending">
                {pending.length ? (
                  <ul className="cards">
                    {pending.map((approval) => (
                      <li key={approval.id} className="card">
                        <div>
                          <strong>#{approval.id}</strong> {approval.toolName}{' '}
                          <span className="muted">requested {time(approval.requestedAt)}</span>
                        </div>
                        <pre className="block">{approval.summary}</pre>
                        <div className="row">
                          <button type="button" onClick={() => decide(approval.id, 'approve')}>
                            Approve
                          </button>
                          <button type="button" className="secondary" onClick={() => decide(approval.id, 'deny')}>
                            Deny
                          </button>
                          <a href={`#/runs/${encodeURIComponent(approval.runId)}`}>run {approval.runId.slice(0, 8)}</a>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>Nothing waits for your approval.</Empty>
                )}
              </Panel>
              <Panel title="History">
                {history.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Id</th>
                        <th>Tool</th>
                        <th>Summary</th>
                        <th>Status</th>
                        <th>Requested</th>
                        <th>Resolved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((approval) => (
                        <tr key={approval.id}>
                          <td>#{approval.id}</td>
                          <td>{approval.toolName}</td>
                          <td className="wrap">{approval.summary}</td>
                          <td>
                            <Status value={approval.status} />
                          </td>
                          <td>{time(approval.requestedAt)}</td>
                          <td>
                            {time(approval.resolvedAt)} {approval.resolvedBy ? <span className="muted">by {approval.resolvedBy}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty>No resolved approvals yet.</Empty>
                )}
              </Panel>
            </>
          );
        }}
      </Load>
    </Page>
  );
}
