import { useState } from 'react';
import type { IntegrationSummary } from '../../../src/dashboard/types';
import { send } from '../api';
import { Panel } from '../components';

// the oauth app of an integration: the redirect url to give the app, a form that stores a pre-registered client, and
// the box for the address of the failed callback page, for a server that accepts only an https redirect.
export function OAuthApp({ integration, onDone }: { integration: IntegrationSummary; onDone: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [pasted, setPasted] = useState('');
  const [notice, setNotice] = useState('');
  const app = integration.oauthApp;
  if (!app) return null;
  const done = (text: string) => {
    setNotice(text);
    onDone();
  };
  const store = () =>
    send<{ stored: true }>(`/api/integrations/${encodeURIComponent(integration.id)}/client`, 'POST', {
      client_id: clientId.trim(),
      ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
    })
      .then(() => done('Stored in the system credential store. Press Connect to sign in.'), (err: Error) => setNotice(err.message))
      .finally(() => setClientSecret(''));
  const finish = () =>
    send<{ text: string }>('/api/integrations/callback', 'POST', { url: pasted }).then(
      (result) => {
        setPasted('');
        done(result.text);
      },
      (err: Error) => setNotice(err.message),
    );
  return (
    <Panel title="OAuth app">
      <p>
        The app must allow this redirect URL: <code>{app.redirectUrl}</code>
      </p>
      {app.clientRef ? (
        <>
          <p className="muted">
            The client of the app is stored in the system credential store (Credential Manager on Windows, the login Keychain on macOS): as{' '}
            <code>{app.clientRef}.ok-computer</code> on Windows, and as the account <code>{app.clientRef}</code> of the service <code>ok-computer</code> on
            macOS. This page never shows it. Store it again to replace it. With an empty secret, the stored secret of the same client id stays.
          </p>
          <div className="row">
            <input aria-label="client id" placeholder="client id" value={clientId} onChange={(event) => setClientId(event.target.value)} />
            <input
              aria-label="client secret"
              placeholder="client secret"
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
            <button type="button" disabled={!clientId.trim()} onClick={store}>
              Store
            </button>
          </div>
        </>
      ) : null}
      {app.callback === 'paste' ? (
        <>
          <p className="muted">
            After you allow the access, the browser shows a page that does not load. Copy the whole address of that page, paste it here, and press
            Finish sign-in. It works once, for 10 minutes.
          </p>
          <div className="row">
            <input aria-label="callback address" placeholder={`${app.redirectUrl}?code=...`} value={pasted} onChange={(event) => setPasted(event.target.value)} />
            <button type="button" disabled={!pasted} onClick={finish}>
              Finish sign-in
            </button>
          </div>
        </>
      ) : null}
      {notice ? <p className="muted">{notice}</p> : null}
    </Panel>
  );
}
