import type { SignalRow } from '../../../src/dashboard/google-types';
import { useApi } from '../api';
import { Empty, Load, Page, Status } from '../components';
import { time } from '../format';

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
