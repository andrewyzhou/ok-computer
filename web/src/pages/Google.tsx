import { useState } from 'react';
import type { GooglePage, GoogleRequestRow, SignalRow } from '../../../src/dashboard/google-types';
import { send, useApi } from '../api';
import { Empty, Expand, Json, Load, Page, Panel, Status } from '../components';
import { ms, time } from '../format';

const pretty = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

// each http request to google as the app sent it, after redaction. a header is never stored.
export function GoogleRequests({ query }: { query: string }) {
  const loaded = useApi<GoogleRequestRow[]>(`/api/google/requests?${query}`);
  return (
    <Load loaded={loaded}>
      {(rows) =>
        rows.length ? (
          <ol className="log-lines">
            {rows.map((row) => (
              <li key={row.id}>
                <span className="muted">{time(row.createdAt)}</span> <strong>{row.method}</strong> <code>{row.url}</code>{' '}
                {row.status !== null ? <span className={row.status < 400 ? 'muted' : 'error-text'}>{row.status}</span> : null}
                {row.latencyMs !== null ? <span className="muted"> {ms(row.latencyMs)}</span> : null}
                {row.account ? <span className="muted"> {row.account}</span> : null}
                {row.error ? <span className="error-text"> {row.error}</span> : null}
                {row.request ? <Expand label="request body">{() => <Json value={pretty(row.request!)} />}</Expand> : null}
                {row.response ? (
                  <Expand label={row.responseBlob ? 'answer (the start; the full answer is a blob)' : 'answer'}>
                    {() => (
                      <>
                        <Json value={pretty(row.response!)} />
                        {row.responseBlob ? <code>blob {row.responseBlob}</code> : null}
                      </>
                    )}
                  </Expand>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No requests to Google.</Empty>
        )
      }
    </Load>
  );
}

// the client file of google cloud has the secret. the page reads it and sends it to the server, which keeps only
// the secret, in the system credential store.
function ClientUpload({ onDone }: { onDone: (text: string) => void }) {
  const upload = async (file: File) => {
    try {
      const result = await send<{ saved: true } | { error: string }>('/api/google/client', 'POST', JSON.parse(await file.text()));
      onDone('error' in result ? result.error : 'The client is stored.');
    } catch (err) {
      onDone((err as Error).message);
    }
  };
  return (
    <label>
      Upload the client file (client_secret_….json):{' '}
      <input type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
    </label>
  );
}

export function Google() {
  const loaded = useApi<GooglePage>('/api/google', (message) => message.kind === 'run');
  const [notice, setNotice] = useState('');
  const connect = (alias: string) =>
    send<{ url: string } | { error: string }>(`/api/google/accounts/${encodeURIComponent(alias)}/connect`, 'POST', {}).then(
      (result) => {
        if ('error' in result) return setNotice(result.error);
        // the consent page opens in a new tab. its last page says whether the sign-in worked.
        window.open(result.url, '_blank', 'noopener');
        setNotice(`Sign in to ${alias} in the new tab, then come back and reload.`);
      },
      (err: Error) => setNotice(err.message),
    );
  return (
    <Page title="Google" actions={<span className="muted">{notice}</span>}>
      <Load loaded={loaded}>
        {(page) =>
          !page.configured ? (
            <Empty>Google is not configured. See docs/setup/google.md.</Empty>
          ) : (
            <>
              <Panel title="Accounts">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Status</th>
                      <th>What to do</th>
                      <th>24 h</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {page.accounts.map((account) => (
                      <tr key={account.alias}>
                        <td>
                          <strong>{account.alias}</strong>
                          <div className="muted">{account.email ?? account.expected ?? 'no address yet'}</div>
                        </td>
                        <td>
                          <Status value={account.status} />
                          {account.alertedAt ? <div className="muted">told you at {time(account.alertedAt)}</div> : null}
                        </td>
                        <td className="wrap">{account.nextStep ?? <span className="muted">nothing</span>}</td>
                        <td>
                          {account.calls24h} calls, {account.errors24h} errors
                        </td>
                        <td>
                          <button type="button" onClick={() => void connect(account.alias)}>
                            {account.status === 'ok' ? 'Reconnect' : 'Connect'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">
                  Client {page.clientId}. <ClientUpload onDone={(text) => (setNotice(text), loaded.reload())} />
                </p>
              </Panel>
              <Panel title={`Polls (every ${page.pollMinutes} minutes)`}>
                {page.lastPoll ? (
                  <p>
                    Last poll {time(page.lastPoll.startedAt)} <Status value={page.lastPoll.status} />{' '}
                    {page.lastPoll.runId ? <a href={`#/runs/${encodeURIComponent(page.lastPoll.runId)}`}>its requests and labels</a> : null}
                    {page.lastPoll.note ? <span className="muted"> {page.lastPoll.note}</span> : null}
                  </p>
                ) : (
                  <Empty>No poll yet.</Empty>
                )}
              </Panel>
              <Panel title={`Tools (sending is ${page.send ? 'on' : 'off'}; sessions: ${page.sessions.join(', ')})`}>
                <table>
                  <tbody>
                    {page.tools.map((tool) => (
                      <tr key={tool.name}>
                        <td>
                          <code>{tool.name}</code>
                        </td>
                        <td>{tool.risk}</td>
                        <td className="wrap muted">{tool.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </>
          )
        }
      </Load>
    </Page>
  );
}

const HANDLED: Record<string, string> = {
  notified: 'the heartbeat told the owner',
  seen: 'the heartbeat read it and stayed silent',
  filtered: 'left out: a quiet label and no detector hit',
  stale: 'no heartbeat handled it in 3 days',
};

export function Signals() {
  const loaded = useApi<SignalRow[]>('/api/signals', (message) => message.kind === 'run');
  return (
    <Page title="Signals">
      <Load loaded={loaded}>
        {(signals) =>
          signals.length ? (
            <table>
              <thead>
                <tr>
                  <th>Seen</th>
                  <th>From</th>
                  <th>Signal</th>
                  <th>Label and detectors</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => (
                  <tr key={signal.id}>
                    <td>
                      #{signal.id} {time(signal.seenAt)}
                    </td>
                    <td>
                      {signal.source}:{signal.account}
                      <div className="muted">{signal.kind.replace('_', ' ')}</div>
                    </td>
                    <td className="wrap">{signal.summary}</td>
                    <td className="wrap">
                      {signal.label ? <Status value={signal.label} /> : signal.source === 'gmail' ? <span className="muted">no label yet</span> : null}
                      {signal.labelModelCallId !== null && signal.runId ? (
                        <a href={`#/runs/${encodeURIComponent(signal.runId)}`} className="muted">
                          {' '}
                          (model call {signal.labelModelCallId})
                        </a>
                      ) : null}
                      {signal.detectors?.map((hit, index) => (
                        <div key={index}>
                          <strong>{hit.name}</strong>: {hit.detail}
                        </div>
                      ))}
                    </td>
                    <td className="wrap">
                      {signal.handledAs ? (
                        <>
                          <Status value={signal.handledAs} /> {HANDLED[signal.handledAs]}
                          {signal.handledBy && signal.handledBy !== 'reset' ? (
                            <>
                              {' '}
                              in <a href={`#/runs/${encodeURIComponent(signal.handledBy)}`}>run {signal.handledBy.slice(0, 8)}</a>
                            </>
                          ) : null}
                          {signal.notification ? <div className="muted">“{signal.notification}”</div> : null}
                        </>
                      ) : (
                        <>
                          <Status value="waiting" /> waits for the next heartbeat
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No signals yet. A poll makes them from new mail and calendar changes.</Empty>
          )
        }
      </Load>
    </Page>
  );
}
