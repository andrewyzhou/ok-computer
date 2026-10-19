import { useState } from 'react';
import type { CatalogVersion, IntegrationDetail as Detail, IntegrationSummary, McpMessageRow, StreamMessage } from '../../../src/dashboard/types';
import { send, useApi } from '../api';
import { Expand, Json, Load } from '../components';
import { ms, time } from '../format';
import { Button, ButtonLink, DetailsPanel, EmptyState, Facts, isNotFound, NotFound, Page, Section, Status, Table, type Column, type Fact } from '../ui';
import { OAuthApp } from './OAuthApp';
import './connections.css';

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
  // the integrations whose request runs. their buttons wait, because a second press of connect would start the
  // sign-in again.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (id: string, on: boolean) =>
    setBusy((before) => {
      const next = new Set(before);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const run = (id: string, promise: () => Promise<string>) => {
    mark(id, true);
    return promise()
      .then(
        (text) => {
          setNotice(text);
          onDone();
        },
        (err: Error) => setNotice(err.message),
      )
      .finally(() => mark(id, false));
  };
  const connect = (id: string) =>
    run(id, () =>
      send<ConnectResult>(`${path(id)}/connect`, 'POST', {}).then((result) => {
        if ('connected' in result) return `${id} is connected.`;
        if ('error' in result) return result.error;
        // the sign-in page opens in a new tab. its callback page says when it is done.
        window.open(result.url, '_blank', 'noopener');
        return `Sign in to ${id} in the new tab. If no tab opened, use the sign-in link on the page of ${id}.`;
      }),
    );
  const pause = (id: string, paused: boolean) =>
    run(id, () => send<{ paused: boolean }>(`${path(id)}/pause`, 'POST', { paused }).then(() => `${id} is ${paused ? 'paused' : 'resumed'}.`));
  return { notice, busy, connect, pause };
}

type Actions = ReturnType<typeof useActions>;

function ActionButtons({ integration, actions }: { integration: IntegrationSummary; actions: Actions }) {
  const busy = actions.busy.has(integration.id);
  if (integration.paused) {
    return (
      <Button size="sm" busy={busy} aria-label={`Resume ${integration.id}`} onClick={() => actions.pause(integration.id, false)}>
        Resume
      </Button>
    );
  }
  return (
    <div className="integrations-actions">
      <Button size="sm" busy={busy} aria-label={`${integration.state.status === 'connected' ? 'Reconnect' : 'Connect'} ${integration.id}`} onClick={() => actions.connect(integration.id)}>
        {integration.state.status === 'connected' ? 'Reconnect' : 'Connect'}
      </Button>
      <Button size="sm" variant="ghost" busy={busy} aria-label={`Pause ${integration.id}`} onClick={() => actions.pause(integration.id, true)}>
        Pause
      </Button>
    </div>
  );
}

// the result of the last action goes to the header, next to the page title, so it stays in view.
function Notice({ text }: { text: string }) {
  return text ? (
    <span className="integrations-notice" role="status">
      {text}
    </span>
  ) : null;
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

// the sign-in of an integration in one line: the kind of auth, when the owner signed in, and when the token ends.
function signIn(integration: IntegrationSummary): string {
  return [integration.auth, integration.authorizedAt ? `signed in ${time(integration.authorizedAt)}` : ''].filter(Boolean).join(', ');
}

// the facts that the list and the page of an integration share. the page adds the server, the sessions and the
// sign-in link.
function summaryFacts(integration: IntegrationSummary): Array<Fact | false> {
  const step = nextStep(integration);
  return [
    {
      label: 'Status',
      value: (
        <>
          <Status value={word(integration)} /> {step ? <span className="integrations-step">{step}</span> : null}
        </>
      ),
    },
    { label: 'Sign-in', value: signIn(integration) },
    { label: 'Token expires', value: integration.tokenExpiresAt ? time(integration.tokenExpiresAt) : <span className="muted">no expiry known</span> },
    {
      label: 'Last error',
      value: integration.lastError ? (
        <span className="error-text">
          {integration.lastError} <span className="muted">{time(integration.lastErrorAt)}</span>
        </span>
      ) : (
        <span className="muted">none</span>
      ),
    },
    {
      label: 'Calls in 24 h',
      value: (
        <>
          {integration.calls24h}
          {integration.errors24h ? <span className="error-text"> ({integration.errors24h} failed)</span> : null}
        </>
      ),
    },
    { label: 'Last message', value: integration.lastMessageAt ? time(integration.lastMessageAt) : <span className="muted">none yet</span> },
    { label: 'Tools', value: <ToolCounts integration={integration} /> },
  ];
}

// a log line of an integration (a state change, a sign-in step, stderr) is the signal that its page changed.
const isLogOf = (id?: string) => (message: StreamMessage) =>
  message.kind === 'log' && message.line.integration !== undefined && (id === undefined || message.line.integration === id);

function columns(actions: Actions): Array<Column<IntegrationSummary>> {
  return [
    {
      key: 'id',
      header: 'Integration',
      cell: (integration) => (
        <span className="integrations-name">
          <a href={href(integration.id)}>{integration.id}</a>
          <span className="muted small">{integration.kind}</span>
        </span>
      ),
    },
    { key: 'state', header: 'State', cell: (integration) => <Status value={word(integration)} /> },
    { key: 'next', header: 'Next step', cell: (integration) => nextStep(integration) ?? <span className="muted">nothing</span>, wrap: true, hideBelow: 'sm', width: '34%' },
    { key: 'tools', header: 'Tools', cell: (integration) => <ToolCounts integration={integration} />, hideBelow: 'md' },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'end', cell: (integration) => <ActionButtons integration={integration} actions={actions} /> },
  ];
}

function IntegrationsBody({ integrations, actions }: { integrations: IntegrationSummary[]; actions: Actions }) {
  const [selected, setSelected] = useState<string | null>(null);
  const integration = integrations.find((each) => each.id === selected);
  const waiting = integrations.filter((each) => nextStep(each) !== null).length;
  return (
    <>
      <Table
        label="integrations"
        columns={columns(actions)}
        rows={integrations}
        rowKey={(each) => each.id}
        selected={selected}
        onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
        empty={
          <EmptyState icon="integration" title="No integrations.">
            Add servers to okc.integrations.json and restart the app.
          </EmptyState>
        }
      />
      {integration ? (
        <DetailsPanel
          title={integration.id}
          openKey={integration.id}
          onClose={() => setSelected(null)}
          actions={
            <ButtonLink href={href(integration.id)} size="sm" icon="integration">
              Open
            </ButtonLink>
          }
        >
          <Facts layout="stacked" items={summaryFacts(integration)} />
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Integrations">
          <Facts
            layout="stacked"
            items={[
              { label: 'Servers', value: integrations.length },
              { label: 'Connected', value: integrations.filter((each) => word(each) === 'connected').length },
              { label: 'Need a step from you', value: waiting },
              { label: 'Calls in 24 h', value: integrations.reduce((sum, each) => sum + each.calls24h, 0) },
            ]}
          />
          <p className="muted small">Select an integration to see its sign-in, its last error and its tools.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Integrations() {
  const loaded = useApi<IntegrationSummary[]>('/api/integrations', isLogOf());
  const actions = useActions(loaded.reload);
  const count = loaded.data?.length;
  return (
    <Page
      title="Integrations"
      subtitle={count !== undefined ? `${count} ${count === 1 ? 'server' : 'servers'} from okc.integrations.json` : undefined}
      actions={<Notice text={actions.notice} />}
    >
      <Load loaded={loaded}>{(integrations) => <IntegrationsBody integrations={integrations} actions={actions} />}</Load>
    </Page>
  );
}

function MessagePayload({ message }: { message: McpMessageRow }) {
  const loaded = useApi<McpMessageRow>(message.payloadBlob ? `/api/mcp-messages/${message.id}` : null);
  if (!message.payloadBlob) return <Json value={message.payload} />;
  return <Load loaded={loaded}>{(full) => <Json value={full.payload} />}</Load>;
}

const ARROW = { out: '→', in: '←', unsent: '✕' } as const;
const DIRECTION = { out: 'sent', in: 'received', unsent: 'not sent' } as const;

// each json-rpc message as the app sent or got it, after redaction. a response shows the time since its request.
export function McpMessages({ messages, showRun = false }: { messages: McpMessageRow[]; showRun?: boolean }) {
  if (!messages.length) return <EmptyState title="No json-rpc messages." />;
  return (
    <ol className="integrations-messages">
      {messages.map((message) => (
        <li key={message.id}>
          <div className="integrations-message-line">
            <span className="muted integrations-time">{time(message.createdAt)}</span>
            <span className="integrations-arrow" title={DIRECTION[message.direction]} aria-label={DIRECTION[message.direction]}>
              {ARROW[message.direction]}
            </span>
            <strong className="integrations-method">{message.method ?? 'response'}</strong>
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
          </div>
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

function DetailFacts({ integration }: { integration: Detail }) {
  return (
    <Facts
      layout="stacked"
      items={[
        ...summaryFacts(integration),
        {
          label: 'Server',
          value: (
            <>
              {integration.state.server ? `${integration.state.server.name} ${integration.state.server.version}, ` : ''}
              {integration.kind} <code>{integration.target}</code>
            </>
          ),
        },
        { label: 'Sessions', value: integration.sessions.join(', ') },
        { label: 'Output', value: integration.untrustedOutput ? 'untrusted: each result taints the session' : 'trusted' },
        Boolean(integration.authUrl) && {
          label: 'Sign-in page',
          value: (
            <a href={integration.authUrl} target="_blank" rel="noopener noreferrer">
              open the sign-in page
            </a>
          ),
        },
        Boolean(integration.withheldScopes?.length) && {
          label: 'Not granted',
          value: (
            <span className="error-text">
              The token does not hold {integration.withheldScopes!.join(', ')}, so tools that need them fail with missing_scope. When the admin allows
              them, press Connect to sign in again.
            </span>
          ),
        },
      ]}
    />
  );
}

const TOOL_COLUMNS: Array<Column<Detail['tools'][number]>> = [
  { key: 'name', header: 'Name', cell: (tool) => <code className="integrations-code">{tool.name}</code> },
  {
    key: 'risk',
    header: 'Risk',
    cell: (tool) => (
      <span className="integrations-risk">
        <Status value={tool.risk} /> <span className="muted">{tool.riskFrom}</span>
      </span>
    ),
    wrap: true,
  },
  {
    key: 'description',
    header: 'Description',
    wrap: true,
    hideBelow: 'sm',
    cell: (tool) => (
      <>
        {tool.description}
        <Expand label="input schema">{() => <Json value={tool.inputSchema} />}</Expand>
      </>
    ),
  },
];

function Tools({ integration }: { integration: Detail }) {
  if (!toolListKnown(integration)) return <EmptyState icon="integration" title="The server never gave a tool list, so its tools are not known yet." />;
  return (
    <div className="integrations-tools">
      {integration.catalogStored ? <p className="muted">This is the tool list from before the last start. The server has not answered since.</p> : null}
      <Table
        label="tools the agent can use"
        columns={TOOL_COLUMNS}
        rows={integration.tools}
        rowKey={(tool) => tool.name}
        empty={<EmptyState title="The server has none of the tools that okc.integrations.json allows." />}
      />
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
      {integration.hidden.length ? <p className="muted">Hidden, because okc.integrations.json does not allow them: {integration.hidden.join(', ')}.</p> : null}
    </div>
  );
}

function Catalogs({ integration }: { integration: Detail }) {
  if (!integration.catalogs.length) return <EmptyState title="The server never gave a tool list." />;
  return (
    <ol className="integrations-lines">
      {integration.catalogs.map((version) => (
        <li key={version.hash}>
          <span className="muted integrations-time">{time(version.createdAt)}</span>
          <span>
            {version.toolCount} tools <CatalogChange version={version} />
          </span>
          <code className="muted">{version.hash.slice(0, 8)}</code>
        </li>
      ))}
    </ol>
  );
}

function Calls({ integration }: { integration: Detail }) {
  if (!integration.calls.length) return <EmptyState title="No tool calls yet." />;
  return (
    <ol className="integrations-lines">
      {integration.calls.map((call) => (
        <li key={call.id}>
          <span className="muted integrations-time">{time(call.createdAt)}</span>
          <span>
            <code>{call.name}</code> <Status value={call.outcome} />
          </span>
          <a href={`#/runs/${encodeURIComponent(call.runId)}`}>run {call.runId.slice(0, 8)}</a>
        </li>
      ))}
    </ol>
  );
}

export function IntegrationDetail({ id }: { id: string; query?: URLSearchParams }) {
  const loaded = useApi<Detail>(path(id), isLogOf(id));
  const actions = useActions(loaded.reload);
  const integration = loaded.data;
  const missing = loaded.error !== undefined && isNotFound(loaded.error);
  return (
    <Page
      title={missing ? 'Integration' : id}
      subtitle={integration ? `${integration.kind} integration` : undefined}
      crumbs={[{ label: 'Integrations', href: '#/integrations' }]}
      actions={
        integration ? (
          <>
            <Notice text={actions.notice} />
            <ActionButtons integration={integration} actions={actions} />
          </>
        ) : undefined
      }
    >
      <Load
        loaded={loaded}
        notFound={
          <NotFound icon="integration" what="integration">
            <a href="#/integrations">Go to all integrations</a>
          </NotFound>
        }
      >
        {(integration) => (
          <>
            <DetailsPanel title={integration.id}>
              <DetailFacts integration={integration} />
            </DetailsPanel>
            <OAuthApp integration={integration} onDone={loaded.reload} />
            <Section title="Tools the agent can use">
              <Tools integration={integration} />
            </Section>
            <Section title="Tool list versions" description="A changed description is in red, because it is new text in front of the model.">
              <Catalogs integration={integration} />
            </Section>
            <Section title="Recent tool calls">
              <Calls integration={integration} />
            </Section>
            <Section title="Json-rpc messages" description="Each message after redaction. Open one to see its payload.">
              <McpMessages messages={integration.messages} showRun />
            </Section>
          </>
        )}
      </Load>
    </Page>
  );
}
