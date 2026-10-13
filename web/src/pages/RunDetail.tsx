import type { ModelCallBody, ModelCallRow, RunDetail as RunDetailData, ToolCallRow } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Expand, Json, Load, Page, Panel, Status } from '../components';
import { EventView } from '../events';
import { duration, ms, time, tokens, usd } from '../format';
import { sessionHref } from './Runs';

function ModelCallBodyView({ id }: { id: number }) {
  const loaded = useApi<ModelCallBody>(`/api/model-calls/${id}`);
  return (
    <Load loaded={loaded}>
      {(body) => (
        <div className="split">
          <div>
            <h3>Request</h3>
            <Json value={body.request} />
          </div>
          <div>
            <h3>Response</h3>
            <Json value={body.response} />
          </div>
        </div>
      )}
    </Load>
  );
}

function ModelCallItem({ call }: { call: ModelCallRow }) {
  return (
    <li className={`step step-model${call.error ? ' is-error' : ''}`}>
      <div className="step-head">
        <strong>model call</strong> {call.provider}/{call.model} <span className="muted">slot {call.slot}</span>
        {call.error ? <Status value="failed" /> : <span className="muted">{call.stopReason}</span>}
      </div>
      <div className="metrics">
        <span>in {tokens(call.inputTokens)}</span>
        <span>out {tokens(call.outputTokens)}</span>
        <span>cache read {tokens(call.cacheReadTokens)}</span>
        <span>cache write {tokens(call.cacheWriteTokens)}</span>
        <span>{usd(call.costUsd)}</span>
        <span>{ms(call.latencyMs)}</span>
        <span className="muted">{time(call.createdAt)}</span>
      </div>
      {call.error ? <p className="error-text">{call.error}</p> : null}
      <Expand label="full request and response">{() => <ModelCallBodyView id={call.id} />}</Expand>
    </li>
  );
}

function ToolCallItem({ call }: { call: ToolCallRow }) {
  return (
    <li className={`step step-tool${call.isError ? ' is-error' : ''}`}>
      <div className="step-head">
        <strong>tool call</strong> {call.name} {call.isError ? <Status value="error" /> : null}
        <span className="muted">{ms(call.durationMs)}</span>
      </div>
      <Expand label="input">{() => <Json value={call.input} />}</Expand>
      <Expand label="output">{() => <Json value={call.output.content} />}</Expand>
    </li>
  );
}

export function RunDetail({ id }: { id: string }) {
  const loaded = useApi<RunDetailData>(
    `/api/runs/${encodeURIComponent(id)}`,
    (message) => (message.kind === 'run' && message.run.id === id) || (message.kind === 'event' && message.event.runId === id),
  );
  return (
    <Page title={`Run ${id.slice(0, 8)}`} actions={<a href="#/runs">All runs</a>}>
      <Load loaded={loaded}>
        {({ run, timeline, events }) => (
          <>
            <dl className="facts wide">
              <dt>Status</dt>
              <dd>
                <Status value={run.status} /> {run.error ? <span className="error-text">{run.error}</span> : null}
              </dd>
              <dt>Session</dt>
              <dd>
                <a href={sessionHref(run.sessionKey)}>{run.sessionKey}</a>
              </dd>
              <dt>Trigger</dt>
              <dd>
                {run.trigger}, slot {run.slot}
              </dd>
              <dt>Time</dt>
              <dd>
                {time(run.startedAt)}, {duration(run.startedAt, run.endedAt)}
              </dd>
              <dt>Cost</dt>
              <dd>
                {usd(run.costUsd)} in {run.modelCalls} model calls and {run.toolCalls} tool calls
              </dd>
            </dl>
            <Panel title="Timeline">
              <ol className="timeline">
                {timeline.map((item) =>
                  item.kind === 'model' ? (
                    <ModelCallItem key={`m${item.call.id}`} call={item.call} />
                  ) : (
                    <ToolCallItem key={`t${item.call.id}`} call={item.call} />
                  ),
                )}
              </ol>
            </Panel>
            <Panel title="Events of this run">
              <div className="log">
                {events.map((event) => (
                  <EventView key={event.id} event={event} />
                ))}
              </div>
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}
