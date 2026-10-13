import { useState } from 'react';
import type { CatalogVersion, IntegrationDetail as Detail, IntegrationSummary, McpMessageRow, StreamMessage } from '../../../src/dashboard/types';
import { send, useApi } from '../api';
import { Empty, Expand, Json, Load, Page, Panel, Status } from '../components';
import { ms, time } from '../format';

const href = (id: string) => `#/integrations/${encodeURIComponent(id)}`;
const path = (id: string) => `/api/integrations/${encodeURIComponent(id)}`;

// paused is a choice of the owner, so it wins over the state of the connection.
const word = (integration: IntegrationSummary) => (integration.paused ? 'paused' : integration.state.status);
const toolListKnown = (integration: IntegrationSummary) => integration.catalogHash !== undefined;

// one sentence that tells the owner what to do. the details are on the page of the integration.
export function nextStep(integration: IntegrationSummary): string | null {
  const { state } = integration;
  if (integration.paused) return 'You paused it. Its tools do not run until you resume it.';
  if (state.status === 'needs_auth') {
    return integration.authorizedAt ? 'The sign-in stopped working. Connect it to sign in again.' : 'Connect it to sign in for the first time.';
  }
  if (state.status === 'error') return `It failed: ${state.error ?? 'unknown error'}.${state.retryAt ? ` The app tries again at ${time(state.retryAt)}.` : ''}`;
  if (state.status === 'connecting') return 'The app connects it now.';
  if (integration.missing.length) {
    const one = integration.missing.length === 1;
    return `okc.integrations.json allows ${integration.missing.join(', ')}, but the server does not have ${one ? 'it' : 'them'}.`;
  }
  return null;
}

type ConnectResult = { connected: true } | { url: string } | { error: string };

function useActions(onDone: () => void) {
  const [notice, setNotice] = useState('');
  const run = (promise: Promise<string>) =>
    promise.then(
      (text) => {
        setNotice(text);
        onDone();
      },
      (err: Error) => setNotice(err.message),
    );
  const connect = (id: string) =>
    run(
      send<ConnectResult>(`${path(id)}/connect`, 'POST', {}).then((result) => {
        if ('connected' in result) return `${id} is connected.`;
        if ('error' in result) return result.error;
        // the sign-in page opens in a new tab. its callback page says when it is done.
        window.open(result.url, '_blank', 'noopener');
        return `Sign in to ${id} in the new tab. If no tab opened, use the sign-in link on the page of ${id}.`;
      }),
    );
  const pause = (id: string, paused: boolean) =>
    run(send<{ paused: boolean }>(`${path(id)}/pause`, 'POST', { paused }).then(() => `${id} is ${paused ? 'paused' : 'resumed'}.`));
  return { notice, connect, pause };
}

function Actions({ integration, actions }: { integration: IntegrationSummary; actions: ReturnType<typeof useActions> }) {
  if (integration.paused) {
    return (
      <button type="button" onClick={() => actions.pause(integration.id, false)}>
        Resume
      </button>
    );
  }
  return (
    <div className="row">
      <button type="button" onClick={() => actions.connect(integration.id)}>
        {integration.state.status === 'connected' ? 'Reconnect' : 'Connect'}
      </button>
      <button type="button" className="secondary" onClick={() => actions.pause(integration.id, true)}>
        Pause
      </button>
    </div>
  );
}

function ToolCounts({ integration }: { integration: IntegrationSummary }) {
  if (!toolListKnown(integration)) return <span className="muted">not known yet</span>;
  return (
    <>
      {integration.tools.length} allowed
      {integration.hidden.length ? <span className="muted">, {integration.hidden.length} hidden</span> : null}
      {integration.missing.length ? <span className="error-text">, {integration.missing.length} missing</span> : null}
    </>
  );
}

// a log line of an integration (a state change, a sign-in step, stderr) is the signal that its page changed.
const isLogOf = (id?: string) => (message: StreamMessage) =>
  message.kind === 'log' && message.line.integration !== undefined && (id === undefined || message.line.integration === id);

export function Integrations() {
  const loaded = useApi<IntegrationSummary[]>('/api/integrations', isLogOf());
  const actions = useActions(loaded.reload);
  return (
    <Page title="Integrations" actions={<span className="muted">{actions.notice}</span>}>
      <Load loaded={loaded}>
        {(integrations) =>
          integrations.length ? (
            <table>
              <thead>
                <tr>
                  <th>Integration</th>
                  <th>Status</th>
                  <th>Tools</th>
                  <th>Calls in 24 h</th>
                  <th>Last message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {integrations.map((integration) => (
                  <tr key={integration.id}>
                    <td>
                      <a href={href(integration.id)}>{integration.id}</a> <span className="muted">{integration.kind}</span>
                    </td>
                    <td className="wrap">
                      <Status value={word(integration)} /> {nextStep(integration)}
                    </td>
                    <td>
                      <ToolCounts integration={integration} />
                    </td>
                    <td>
                      {integration.calls24h}
                      {integration.errors24h ? <span className="error-text"> ({integration.errors24h} failed)</span> : null}
                    </td>
                    <td>{time(integration.lastMessageAt)}</td>
                    <td>
                      <Actions integration={integration} actions={actions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No integrations. Add servers to okc.integrations.json and restart the app.</Empty>
          )
        }
      </Load>
    </Page>
  );
}

function MessagePayload({ message }: { message: McpMessageRow }) {
  const loaded = useApi<McpMessageRow>(message.payloadBlob ? `/api/mcp-messages/${message.id}` : null);
  if (!message.payloadBlob) return <Json value={message.payload} />;
  return <Load loaded={loaded}>{(full) => <Json value={full.payload} />}</Load>;
}

const ARROW = { out: '→', in: '←', unsent: '✕' } as const;

// each json-rpc message as the app sent or got it, after redaction. a response shows the time since its request.
export function McpMessages({ messages, showRun = false }: { messages: McpMessageRow[]; showRun?: boolean }) {
  if (!messages.length) return <Empty>No json-rpc messages.</Empty>;
  return (
    <ol className="log-lines">
      {messages.map((message) => (
        <li key={message.id}>
          <span className="muted">{time(message.createdAt)}</span> {ARROW[message.direction]} <strong>{message.method ?? 'response'}</strong>
          {message.direction === 'unsent' ? <span className="error-text"> not sent</span> : null}
          {message.rpcId ? <span className="muted"> #{message.rpcId}</span> : null}
          {message.latencyMs !== null ? <span className="muted"> {ms(message.latencyMs)}</span> : null}
          {message.error ? (
            <>
              {' '}
              <Status value="error" /> <span className="error-text">{message.error}</span>
            </>
          ) : null}
          {showRun && message.runId ? (
            <>
              {' '}
              <a href={`#/runs/${encodeURIComponent(message.runId)}`}>run {message.runId.slice(0, 8)}</a>
            </>
          ) : null}
          <Expand label="message">{() => <MessagePayload message={message} />}</Expand>
        </li>
      ))}
    </ol>
  );
}

// a new description is new text in front of the model, so the owner checks it like a change to the prompt.
function CatalogChange({ version }: { version: CatalogVersion }) {
  if (!version.diff) return <span className="muted">first version</span>;
  const { added, removed, changed } = version.diff;
  if (!added.length && !removed.length && !changed.length) return <span className="muted">no change in the allowed tools</span>;
  return (
    <span className="wrap">
      {added.length ? <span>added {added.join(', ')}. </span> : null}
      {removed.length ? <span>removed {removed.join(', ')}. </span> : null}
      {changed.map((change) => (
        <span key={change.name} className={change.fields.includes('description') ? 'error-text' : undefined}>
          changed the {change.fields.join(' and ')} of {change.name}.{' '}
        </span>
      ))}
    </span>
  );
}

function Facts({ integration }: { integration: Detail }) {
  return (
    <dl className="facts wide">
      <dt>Status</dt>
      <dd>
        <Status value={word(integration)} /> {nextStep(integration)}
      </dd>
      <dt>Server</dt>
      <dd>
        {integration.state.server ? `${integration.state.server.name} ${integration.state.server.version}, ` : ''}
        {integration.kind} <code>{integration.target}</code>
      </dd>
      <dt>Sessions</dt>
      <dd>{integration.sessions.join(', ')}</dd>
      <dt>Output</dt>
      <dd>{integration.untrustedOutput ? 'untrusted: each result taints the session' : 'trusted'}</dd>
      <dt>Sign-in</dt>
      <dd>
        {integration.auth}
        {integration.authorizedAt ? `, signed in ${time(integration.authorizedAt)}` : ''}
        {integration.tokenExpiresAt ? `, token expires ${time(integration.tokenExpiresAt)}` : ''}
        {integration.authUrl ? (
          <>
            {' '}
            <a href={integration.authUrl} target="_blank" rel="noopener noreferrer">
              open the sign-in page
            </a>
          </>
        ) : null}
      </dd>
      {integration.lastError ? (
        <>
          <dt>Last error</dt>
          <dd className="error-text">
            {integration.lastError} <span className="muted">{time(integration.lastErrorAt)}</span>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function Tools({ integration }: { integration: Detail }) {
  if (!toolListKnown(integration)) return <Empty>The server never gave a tool list, so its tools are not known yet.</Empty>;
  return (
    <>
      {integration.catalogStored ? <p className="muted">This is the tool list from before the last start. The server has not answered since.</p> : null}
      {integration.tools.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Risk</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {integration.tools.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <code>{tool.name}</code>
                </td>
                <td>
                  <Status value={tool.risk} /> <span className="muted">{tool.riskFrom}</span>
                </td>
                <td className="wrap">
                  {tool.description}
                  <Expand label="input schema">{() => <Json value={tool.inputSchema} />}</Expand>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>The server has none of the tools that okc.integrations.json allows.</Empty>
      )}
      {integration.rejected.map((each) => (
        <p key={each.mcpName} className="error-text">
          {each.mcpName} is not available to the agent: {each.reason}.
        </p>
      ))}
      {integration.missing.length ? (
        <p className="error-text">
          okc.integrations.json allows {integration.missing.join(', ')}, but the server does not have {integration.missing.length === 1 ? 'it' : 'them'}.
          Check the spelling, or the server version.
        </p>
      ) : null}
      {integration.unknown.length ? (
        <p className="muted">Not known yet, because the server has not given a tool list since they were allowed: {integration.unknown.join(', ')}.</p>
      ) : null}
      {integration.hidden.length ? (
        <p className="muted">Hidden, because okc.integrations.json does not allow them: {integration.hidden.join(', ')}.</p>
      ) : null}
    </>
  );
}

export function IntegrationDetail({ id }: { id: string }) {
  const loaded = useApi<Detail>(path(id), isLogOf(id));
  const actions = useActions(loaded.reload);
  return (
    <Page title={`Integration ${id}`} actions={<a href="#/integrations">All integrations</a>}>
      <Load loaded={loaded}>
        {(integration) => (
          <>
            <Facts integration={integration} />
            <div className="row">
              <Actions integration={integration} actions={actions} /> <span className="muted">{actions.notice}</span>
            </div>
            <Panel title="Tools the agent can use">
              <Tools integration={integration} />
            </Panel>
            <Panel title="Tool list versions">
              {integration.catalogs.length ? (
                <ol className="log-lines">
                  {integration.catalogs.map((version) => (
                    <li key={version.hash}>
                      <span className="muted">{time(version.createdAt)}</span> {version.toolCount} tools <CatalogChange version={version} />{' '}
                      <code className="muted">{version.hash.slice(0, 8)}</code>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>The server never gave a tool list.</Empty>
              )}
            </Panel>
            <Panel title="Recent tool calls">
              {integration.calls.length ? (
                <ol className="log-lines">
                  {integration.calls.map((call) => (
                    <li key={call.id}>
                      <span className="muted">{time(call.createdAt)}</span> {call.name} <Status value={call.outcome} />{' '}
                      <a href={`#/runs/${encodeURIComponent(call.runId)}`}>run {call.runId.slice(0, 8)}</a>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>No tool calls yet.</Empty>
              )}
            </Panel>
            <Panel title="Json-rpc messages">
              <McpMessages messages={integration.messages} showRun />
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}
