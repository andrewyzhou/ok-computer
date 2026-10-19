import { useState } from 'react';
import type { GoogleAccountView, GooglePage, GoogleRequestRow } from '../../../src/dashboard/google-types';
import { send, useApi } from '../api';
import { Expand, Json, Load } from '../components';
import { ms, time } from '../format';
import { Badge, Button, DetailsPanel, EmptyState, Facts, Page, Section, Status, Table, toneOf, type Column } from '../ui';
import './connections.css';

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
          <ol className="google-requests" aria-label="requests to google">
            {rows.map((row) => (
              <li key={row.id} className="google-request">
                <div className="google-request-line">
                  <span className="muted google-time">{time(row.createdAt)}</span>
                  <strong className="google-method">{row.method}</strong>
                  <code className="google-url">{row.url}</code>
                  {row.status !== null ? <span className={row.status < 400 ? 'muted google-status' : 'error-text google-status'}>{row.status}</span> : null}
                  {row.latencyMs !== null ? <span className="muted google-latency">{ms(row.latencyMs)}</span> : null}
                  {row.account ? <span className="muted">{row.account}</span> : null}
                </div>
                {row.error ? <div className="error-text">{row.error}</div> : null}
                {row.request || row.response ? (
                  <div className="google-bodies">
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
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState title="No requests to Google." />
        )
      }
    </Load>
  );
}

// the client file of google cloud has the secret. the page reads it and sends it to the server, which keeps only
// the secret, in the credential manager.
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
    <label className="btn btn-secondary btn-sm google-upload">
      Upload the client file
      <input
        type="file"
        className="sr-only"
        aria-label="Upload the client file (client_secret_….json)"
        accept="application/json,.json"
        onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])}
      />
    </label>
  );
}

function AccountFacts({ account }: { account: GoogleAccountView }) {
  return (
    <Facts
      layout="stacked"
      items={[
        { label: 'Status', value: <Status value={account.status} /> },
        { label: 'What to do', value: account.nextStep ?? <span className="muted">nothing</span> },
        { label: 'Address', value: account.email ?? <span className="muted">no sign-in yet</span> },
        account.expected !== null && account.expected !== account.email && { label: 'Expected address', value: account.expected },
        { label: 'Signed in', value: account.authorizedAt ? time(account.authorizedAt) : <span className="muted">never</span> },
        Boolean(account.lastError) && {
          label: 'Last error',
          value: (
            <span className="error-text">
              {account.lastError} <span className="muted">{time(account.lastErrorAt)}</span>
            </span>
          ),
        },
        account.failures > 0 && { label: 'Failures in a row', value: account.failures },
        Boolean(account.alertedAt) && { label: 'Told you', value: time(account.alertedAt) },
        { label: 'In 24 h', value: `${account.calls24h} calls, ${account.errors24h} errors` },
      ]}
    />
  );
}

function accountColumns(connect: (alias: string) => void, busy: string | null): Array<Column<GoogleAccountView>> {
  return [
    {
      key: 'alias',
      header: 'Account',
      cell: (account) => (
        <div className="google-account">
          <strong>{account.alias}</strong>
          <span className="muted google-email">{account.email ?? account.expected ?? 'no address yet'}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status and 24 h',
      cell: (account) => (
        <div className="google-account">
          <Status value={account.status} />
          {account.alertedAt ? <span className="muted small">told you at {time(account.alertedAt)}</span> : null}
          <span className="muted small">{`${account.calls24h} calls, ${account.errors24h} errors`}</span>
        </div>
      ),
    },
    { key: 'next', header: 'What to do', cell: (account) => account.nextStep ?? <span className="muted">nothing</span>, wrap: true, hideBelow: 'sm', width: '34%' },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      cell: (account) => (
        <Button size="sm" variant={account.status === 'ok' ? 'secondary' : 'primary'} busy={busy === account.alias} onClick={() => connect(account.alias)}>
          {account.status === 'ok' ? 'Reconnect' : 'Connect'}
        </Button>
      ),
    },
  ];
}

// the risk of a tool is a list, for example "write, external with attendees". its first word gives the tone.
function Risk({ value }: { value: string }) {
  return <Badge tone={toneOf(value.split(/[ ,]/)[0] ?? '')}>{value}</Badge>;
}

const TOOL_COLUMNS: Array<Column<GooglePage['tools'][number]>> = [
  { key: 'name', header: 'Name', cell: (tool) => <code className="google-code">{tool.name}</code> },
  { key: 'risk', header: 'Risk', cell: (tool) => <Risk value={tool.risk} /> },
  { key: 'description', header: 'Description', cell: (tool) => <span className="muted">{tool.description}</span>, wrap: true, hideBelow: 'sm' },
];

function GoogleBody({ page, connect, busy, onUpload }: { page: GooglePage; connect: (alias: string) => void; busy: string | null; onUpload: (text: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const account = page.accounts.find((each) => each.alias === selected);
  return (
    <>
      <Section title="Accounts" description="Select an account to see its sign-in and its last error.">
        <Table
          label="google accounts"
          columns={accountColumns(connect, busy)}
          rows={page.accounts}
          rowKey={(each) => each.alias}
          selected={selected}
          onSelect={(each) => setSelected(each.alias === selected ? null : each.alias)}
          empty={<EmptyState icon="google" title="No accounts.">Add an account to the google part of okc.config.json.</EmptyState>}
        />
        <div className="google-client">
          <span className="muted">{page.clientId ? <>Client <span className="google-client-id">{page.clientId}</span></> : 'No client is stored yet.'}</span>
          <ClientUpload onDone={onUpload} />
        </div>
      </Section>
      <Section title="Polls" description={`Every ${page.pollMinutes} minutes.`}>
        {page.lastPoll ? (
          <p className="google-poll">
            Last poll {time(page.lastPoll.startedAt)} <Status value={page.lastPoll.status} />{' '}
            {page.lastPoll.runId ? <a href={`#/runs/${encodeURIComponent(page.lastPoll.runId)}`}>its requests and labels</a> : null}
            {page.lastPoll.note ? <span className="muted"> {page.lastPoll.note}</span> : null}
          </p>
        ) : (
          <EmptyState title="No poll yet." />
        )}
      </Section>
      <Section title="Tools" description={`Sending is ${page.send ? 'on' : 'off'}. Sessions: ${page.sessions.join(', ')}.`}>
        <Table label="google tools" columns={TOOL_COLUMNS} rows={page.tools} rowKey={(tool) => tool.name} empty={<EmptyState title="No tools." />} />
      </Section>
      {account ? (
        <DetailsPanel title={account.alias} openKey={account.alias} onClose={() => setSelected(null)}>
          <AccountFacts account={account} />
          <div>
            <Button size="sm" variant="primary" busy={busy === account.alias} onClick={() => connect(account.alias)}>
              {account.status === 'ok' ? 'Reconnect' : 'Connect'} {account.alias}
            </Button>
          </div>
        </DetailsPanel>
      ) : (
        <DetailsPanel title="Google">
          <Facts
            layout="stacked"
            items={[
              { label: 'Accounts', value: page.accounts.length },
              { label: 'Need a step from you', value: page.accounts.filter((each) => each.nextStep !== null).length },
              { label: 'Sending', value: <Status value={page.send ? 'on' : 'off'} /> },
              { label: 'Poll', value: `every ${page.pollMinutes} minutes` },
            ]}
          />
          <p className="muted small">Select an account to see its sign-in and its last error.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Google() {
  const loaded = useApi<GooglePage>('/api/google', (message) => message.kind === 'run');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const connect = (alias: string) => {
    setBusy(alias);
    void send<{ url: string } | { error: string }>(`/api/google/accounts/${encodeURIComponent(alias)}/connect`, 'POST', {})
      .then(
        (result) => {
          if ('error' in result) return setNotice(result.error);
          // the consent page opens in a new tab. its last page says whether the sign-in worked.
          window.open(result.url, '_blank', 'noopener');
          setNotice(`Sign in to ${alias} in the new tab, then come back and reload.`);
        },
        (err: Error) => setNotice(err.message),
      )
      .finally(() => setBusy(null));
  };
  return (
    <Page
      title="Google"
      subtitle="Mail and calendar accounts"
      actions={
        notice ? (
          <span className="google-notice" role="status">
            {notice}
          </span>
        ) : undefined
      }
    >
      <Load loaded={loaded}>
        {(page) =>
          !page.configured ? (
            <EmptyState icon="google" title="Google is not configured.">
              See docs/setup/google.md.
            </EmptyState>
          ) : (
            <GoogleBody page={page} connect={connect} busy={busy} onUpload={(text) => (setNotice(text), loaded.reload())} />
          )
        }
      </Load>
    </Page>
  );
}
