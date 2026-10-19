import { useState } from 'react';
import type { PolicyListRow, PolicyPage, PolicyRuleRow } from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Load, Status } from '../components';
import { time } from '../format';
import type { RouteProps } from '../routes';
import { ButtonLink, DetailsPanel, EmptyState, Facts, FilterBar, Page, Section, Select, Table, type Column } from '../ui';
import { runHref, sessionHref } from './Runs';
import './dev.css';

const DECISIONS = ['allow', 'review', 'approve', 'deny'];
const VERDICTS = ['allow', 'hold'];

const DECISION_COLUMNS: Array<Column<PolicyListRow>> = [
  { key: 'time', header: 'Time', cell: (row) => time(row.createdAt), hideBelow: 'sm' },
  { key: 'tool', header: 'Tool', cell: (row) => row.toolName },
  {
    key: 'decision',
    header: 'Decision',
    cell: (row) => (
      <span className="policy-words">
        <Status value={row.decision} /> {row.reviewerVerdict ? <Status value={row.reviewerVerdict} /> : null}{' '}
        {row.approvalStatus ? <Status value={row.approvalStatus} /> : null}
      </span>
    ),
  },
  { key: 'rule', header: 'Rule', cell: (row) => <code className="dev-id">{row.rule}</code>, hideBelow: 'md' },
  {
    key: 'reason',
    header: 'Reason',
    wrap: true,
    hideBelow: 'sm',
    cell: (row) => (
      <>
        {row.reason}
        {row.reviewerReason ? <div className="muted">reviewer: {row.reviewerReason}</div> : null}
      </>
    ),
  },
  { key: 'session', header: 'Session', cell: (row) => <a href={sessionHref(row.sessionKey)}>{row.sessionKey}</a>, hideBelow: 'md' },
  {
    key: 'run',
    header: 'Run',
    cell: (row) => (
      <a className="dev-id" href={runHref(row.runId)}>
        {row.runId.slice(0, 8)}
      </a>
    ),
    hideBelow: 'sm',
  },
];

const RULE_COLUMNS: Array<Column<PolicyRuleRow>> = [
  { key: 'id', header: 'Rule', cell: (rule) => <code className="dev-id">{rule.id}</code> },
  // the rule id already holds the tool name, so a phone leaves the tool column out.
  { key: 'tool', header: 'Tool', cell: (rule) => rule.tool, hideBelow: 'sm' },
  { key: 'session', header: 'Session', cell: (rule) => rule.session ?? '', hideBelow: 'md' },
  { key: 'args', header: 'Args', cell: (rule) => (rule.args ? <code className="dev-id">{JSON.stringify(rule.args)}</code> : ''), wrap: true, hideBelow: 'md' },
  { key: 'effect', header: 'Effect', cell: (rule) => <Status value={rule.effect} /> },
  { key: 'note', header: 'Note', cell: (rule) => rule.note ?? '', wrap: true, hideBelow: 'sm' },
];

// the built-in rules have no session and no args, so these columns show only when a rule has one. each value still
// shows, and the notes get the room.
function ruleColumns(rules: PolicyRuleRow[]): Array<Column<PolicyRuleRow>> {
  return RULE_COLUMNS.filter(
    (column) => (column.key !== 'session' || rules.some((rule) => rule.session)) && (column.key !== 'args' || rules.some((rule) => rule.args)),
  );
}

function DecisionPanel({ row, onClose }: { row: PolicyListRow; onClose: () => void }) {
  return (
    <DetailsPanel title={row.toolName} openKey={row.id} onClose={onClose}>
      <Facts
        layout="stacked"
        items={[
          { label: 'Time', value: time(row.createdAt) },
          { label: 'Decision', value: <Status value={row.decision} /> },
          { label: 'Rule', value: <code className="dev-id">{row.rule}</code> },
          { label: 'Reason', value: row.reason },
          row.reviewerVerdict
            ? {
                label: 'Reviewer',
                value: (
                  <>
                    <Status value={row.reviewerVerdict} /> {row.reviewerReason}
                  </>
                ),
              }
            : null,
          row.approvalId !== null && {
            label: 'Approval',
            value: (
              <>
                <a href="#/approvals">#{row.approvalId}</a> {row.approvalStatus ? <Status value={row.approvalStatus} /> : null}
              </>
            ),
          },
          {
            label: 'Taint',
            value: row.taint.length ? (
              <ul className="policy-taint">
                {row.taint.map((each) => (
                  <li key={`${each.source}-${each.toolCallId}`}>
                    {each.source}, read by {each.toolName} at {time(each.at)}
                    {each.runId ? (
                      <>
                        {' '}
                        in <a href={runHref(each.runId)}>run {each.runId.slice(0, 8)}</a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">The session had read no untrusted source.</span>
            ),
          },
          { label: 'Session', value: <a href={sessionHref(row.sessionKey)}>{row.sessionKey}</a> },
        ]}
      />
      <div className="dev-panel-actions">
        <ButtonLink href={runHref(row.runId)} size="sm" variant="primary" icon="run">
          Open the run
        </ButtonLink>
      </div>
    </DetailsPanel>
  );
}

function PolicyBody({ page }: { page: PolicyPage }) {
  const [selected, setSelected] = useState<number | null>(null);
  const row = page.decisions.find((each) => each.id === selected);
  return (
    <>
      <Section id="policy-decisions" title="Recent decisions" description="Newest first. Select one to see its reason, the reviewer and the taint.">
        <div className="policy-decisions">
          <Table
            label="policy decisions"
            dense
            columns={DECISION_COLUMNS}
            rows={page.decisions}
            rowKey={(each) => String(each.id)}
            selected={selected === null ? null : String(selected)}
            onSelect={(each) => setSelected(each.id === selected ? null : each.id)}
            empty={<EmptyState icon="policy" title="No policy decision matches." />}
          />
        </div>
      </Section>
      <Section title="Rules" description="The built-in rules, then the rules of okc.policy.json. A deny rule always wins.">
        <div className="policy-rules">
          <Table label="policy rules" dense columns={ruleColumns(page.rules)} rows={page.rules} rowKey={(rule) => rule.id} />
        </div>
      </Section>
      {row ? (
        <DecisionPanel row={row} onClose={() => setSelected(null)} />
      ) : (
        <DetailsPanel title="Policy">
          <Facts
            layout="stacked"
            items={[
              { label: 'Decisions shown', value: page.decisions.length },
              { label: 'Held by the reviewer', value: page.decisions.filter((each) => each.reviewerVerdict === 'hold').length },
              { label: 'Denied', value: page.decisions.filter((each) => each.decision === 'deny').length },
              { label: 'Rules', value: page.rules.length },
            ]}
          />
          <p className="muted small">Select a decision to see its details.</p>
        </DetailsPanel>
      )}
    </>
  );
}

export function Policy(_props: Partial<RouteProps>) {
  const [filter, setFilter] = useState({ decision: '', verdict: '' });
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  const loaded = useApi<PolicyPage>(`/api/policy${query ? `?${query}` : ''}`, (message) => message.kind === 'run' || message.kind === 'policy');
  return (
    <Page
      title="Policy"
      width="full"
      toolbar={
        <FilterBar>
          <Select label="decision" value={filter.decision} options={DECISIONS} allLabel="all" onChange={(decision) => setFilter({ ...filter, decision })} />
          <Select label="verdict" value={filter.verdict} options={VERDICTS} allLabel="all" onChange={(verdict) => setFilter({ ...filter, verdict })} />
        </FilterBar>
      }
    >
      <Load loaded={loaded}>{(page) => <PolicyBody page={page} />}</Load>
    </Page>
  );
}
