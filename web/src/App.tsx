import { useEffect, useState, type ReactNode } from 'react';
import type { Meta } from '../../src/dashboard/types';
import { useApi } from './api';
import { Load } from './components';
import { setTimeZone } from './format';
import { Approvals } from './pages/Approvals';
import { Automations } from './pages/Automations';
import { Cost } from './pages/Cost';
import { Goals } from './pages/Goals';
import { BrowserTask, BrowserTasks } from './pages/Browser';
import { IntegrationDetail, Integrations } from './pages/Integrations';
import { Logs } from './pages/Logs';
import { Memory } from './pages/Memory';
import { Overview } from './pages/Overview';
import { RunDetail } from './pages/RunDetail';
import { Runs } from './pages/Runs';
import { SessionDetail, Sessions } from './pages/Sessions';

const NAV = [
  ['', 'Overview'],
  ['runs', 'Runs'],
  ['sessions', 'Sessions'],
  ['automations', 'Automations'],
  ['goals', 'Goals'],
  ['memory', 'Memory'],
  ['approvals', 'Approvals'],
  ['integrations', 'Integrations'],
  ['browser', 'Browser'],
  ['cost', 'Cost'],
  ['logs', 'Logs'],
] as const;

// the routes live in the hash, so the server needs to serve only index.html and the assets.
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#\/?/, '');
}

export function route(path: string): ReactNode {
  const [section = '', ...rest] = path.split('/');
  const param = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  switch (section) {
    case '':
      return <Overview />;
    case 'runs':
      return param ? <RunDetail key={param} id={param} /> : <Runs />;
    case 'sessions':
      return param ? <SessionDetail key={param} sessionKey={param} /> : <Sessions />;
    case 'automations':
      return <Automations />;
    case 'goals':
      return <Goals />;
    case 'memory':
      return <Memory />;
    case 'approvals':
      return <Approvals />;
    case 'integrations':
      return param ? <IntegrationDetail key={param} id={param} /> : <Integrations />;
    case 'browser':
      return param ? <BrowserTask key={param} id={param} /> : <BrowserTasks />;
    case 'cost':
      return <Cost />;
    case 'logs':
      return <Logs />;
    default:
      return <p className="error-box">This page does not exist.</p>;
  }
}

export function App() {
  const path = useHash();
  const meta = useApi<Meta>('/api/meta');
  const section = path.split('/')[0] ?? '';
  return (
    <div className="shell">
      <nav className="nav" aria-label="pages">
        <div className="brand">OK Computer</div>
        {NAV.map(([href, label]) => (
          <a key={href} href={`#/${href}`} className={section === href ? 'active' : ''}>
            {label}
          </a>
        ))}
      </nav>
      <main className="main">
        <Load loaded={meta}>
          {(data) => {
            setTimeZone(data.timeZone);
            return route(path);
          }}
        </Load>
      </main>
    </div>
  );
}
