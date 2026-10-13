import { useState } from 'react';
import type { IntegrationSummary } from '../../../src/dashboard/types';
import { send } from '../api';
import { Panel } from '../components';

// the oauth app of an integration: the redirect url to give the app, and the box for the address of the failed
// callback page, for a server that accepts only an https redirect.
export function OAuthApp({ integration, onDone }: { integration: IntegrationSummary; onDone: () => void }) {
  const [pasted, setPasted] = useState('');
  const [notice, setNotice] = useState('');
  const app = integration.oauthApp;
  if (!app) return null;
  const finish = () =>
    send<{ text: string }>('/api/integrations/callback', 'POST', { url: pasted }).then(
      (result) => {
        setNotice(result.text);
        setPasted('');
        onDone();
      },
      (err: Error) => setNotice(err.message),
    );
  return (
    <Panel title="OAuth app">
      <p>
        The app must allow this redirect URL: <code>{app.redirectUrl}</code>
      </p>
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
