import { useState } from 'react';
import type { AutomationRow, AutomationRunRow, HeartbeatStatus } from '../../../src/dashboard/types';
import { send, useApi } from '../api';
import { Load } from '../components';
import { duration, time } from '../format';
import { Button, DetailsPanel, EmptyState, Facts, Page, Section, Status, Table, type Column } from '../ui';
import './agent.css';

function History({ id }: { id: string }) {
  const loaded = useApi<AutomationRunRow[]>(`/api/automations/${encodeURIComponent(id)}/runs`, (message) => message.kind === 'run');
  return (
    <Load loaded={loaded}>
      {(runs) =>
        runs.length ? (
          <ul className="automations-history" aria-label="history">
            {runs.map((run) => (
              <li key={run.id}>
                <div className="automations-history-head">
                  <Status value={run.status} />
                  <span>{time(run.startedAt)}</span>
                  <span className="muted">{duration(run.startedAt, run.endedAt)}</span>
                  {run.runId ? (
                    <a className="automations-history-run" href={`#/runs/${encodeURIComponent(run.runId)}`}>
                      run {run.runId.slice(0, 8)}
                    </a>
                  ) : null}
                </div>
                {run.error ? <div className="error-text small">{run.error}</div> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="automation" title="This automation did not run yet." />
        )
      }
    </Load>
  );
}

function Checklist() {
  const loaded = useApi<HeartbeatStatus>('/api/heartbeat');
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Section
      title="Heartbeat checklist"
      description="The heartbeat checks these items during active hours. An empty list stops the checks."
    >
      <Load loaded={loaded}>
        {(status) => (
          <form
            className="automations-checklist"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              send('/api/heartbeat/checklist', 'PUT', {
                checklist: draft ?? status.checklist,
              }).then(
                () => {
                  setBusy(false);
                  setNotice('Saved.');
                  setDraft(undefined);
                  loaded.reload();
                },
                (err: Error) => {
                  setBusy(false);
                  setNotice(err.message);
                },
              );
            }}
          >
            <p className="muted small">It runs every {status.every}.</p>
            <textarea
              aria-label="heartbeat checklist"
              rows={6}
              value={draft ?? status.checklist}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="automations-checklist-foot">
              <Button type="submit" variant="primary" size="sm" busy={busy} disabled={draft === undefined}>
                Save checklist
              </Button>
              {notice ? (
                <span className="muted" role="status">
                  {notice}
                </span>
              ) : null}
            </div>
          </form>
        )}
      </Load>
    </Section>
  );
}

function AutomationDetails({ automation, onClose }: { automation: AutomationRow; onClose: () => void }) {
  return (
    <DetailsPanel title={automation.name} openKey={automation.id} onClose={onClose}>
      <Facts
        layout="stacked"
        items={[
          {
            label: 'State',
            value: <Status value={automation.enabled ? 'on' : 'off'} />,
          },
          { label: 'Schedule', value: automation.schedule },
          { label: 'Next run', value: time(automation.nextRunAt) },
          { label: 'Last run', value: time(automation.lastRunAt) },
          { label: 'Id', value: <code>{automation.id}</code> },
          { label: 'Payload', value: automation.payloadType },
          { label: 'Session', value: `${automation.sessionMode} session` },
          { label: 'Slot', value: automation.slot },
          { label: 'Made by', value: automation.createdBy },
          automation.consecutiveFailures > 0 && {
            label: 'Failures in a row',
            value: automation.consecutiveFailures,
          },
        ]}
      />
      <Section title="History">
        <History id={automation.id} />
      </Section>
    </DetailsPanel>
  );
}

export function Automations() {
  const loaded = useApi<AutomationRow[]>('/api/automations', (message) => message.kind === 'run');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = (key: string, promise: Promise<unknown>, done: string) => {
    setBusy(key);
    void promise.then(
      () => {
        setBusy(null);
        setNotice(done);
        loaded.reload();
      },
      (err: Error) => {
        setBusy(null);
        setNotice(err.message);
      },
    );
  };
  const columns: Array<Column<AutomationRow>> = [
    {
      key: 'name',
      header: 'Name',
      wrap: true,
      width: '20%',
      cell: (automation) => <span className="automations-name">{automation.name}</span>,
    },
    {
      key: 'schedule',
      header: 'Schedule',
      cell: (automation) => automation.schedule,
      wrap: true,
      width: '28%',
      hideBelow: 'sm',
    },
    {
      key: 'next',
      header: 'Next run',
      cell: (automation) => time(automation.nextRunAt),
      hideBelow: 'md',
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (automation) => time(automation.lastRunAt),
      hideBelow: 'md',
    },
    {
      key: 'state',
      header: 'State',
      cell: (automation) => (
        <>
          <Status value={automation.enabled ? 'on' : 'off'} />
          {automation.consecutiveFailures ? (
            <span className="automations-failures error-text small">{automation.consecutiveFailures} failures in a row</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      cell: (automation) => {
        const id = encodeURIComponent(automation.id);
        return (
          <span className="automations-actions">
            <Button
              size="sm"
              variant="ghost"
              busy={busy === `toggle:${automation.id}`}
              aria-label={`${automation.enabled ? 'Turn off' : 'Turn on'} ${automation.name}`}
              onClick={() =>
                act(
                  `toggle:${automation.id}`,
                  send(`/api/automations/${id}`, 'POST', {
                    enabled: !automation.enabled,
                  }),
                  `${automation.name} is ${automation.enabled ? 'off' : 'on'}.`,
                )
              }
            >
              {automation.enabled ? 'Turn off' : 'Turn on'}
            </Button>
            <Button
              size="sm"
              icon="play"
              busy={busy === `run:${automation.id}`}
              aria-label={`Run ${automation.name} now`}
              onClick={() => act(`run:${automation.id}`, send(`/api/automations/${id}/run`, 'POST', {}), `${automation.name} started.`)}
            >
              Run now
            </Button>
          </span>
        );
      },
    },
  ];
  const automation = loaded.data?.find((each) => each.id === selected);
  return (
    <Page
      title="Automations"
      subtitle="The scheduled work of the agent. Select one to see its history."
      actions={
        notice ? (
          <span className="muted" role="status">
            {notice}
          </span>
        ) : undefined
      }
    >
      <Load loaded={loaded}>
        {(automations) => (
          <Table
            label="automations"
            columns={columns}
            rows={automations}
            rowKey={(each) => each.id}
            selected={selected}
            onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
            empty={<EmptyState icon="automation" title="No automations yet." />}
          />
        )}
      </Load>
      <Checklist />
      {automation ? (
        <AutomationDetails automation={automation} onClose={() => setSelected(null)} />
      ) : loaded.data ? (
        <DetailsPanel title="Automations">
          <Facts
            layout="stacked"
            items={[
              {
                label: 'On',
                value: loaded.data.filter((each) => each.enabled).length,
              },
              {
                label: 'Off',
                value: loaded.data.filter((each) => !each.enabled).length,
              },
              {
                label: 'Failing',
                value: loaded.data.filter((each) => each.consecutiveFailures > 0).length,
              },
            ]}
          />
          <p className="muted small">Select an automation to see its runs.</p>
        </DetailsPanel>
      ) : null}
    </Page>
  );
}
