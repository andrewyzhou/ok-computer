import { useState } from 'react';
import type {
  AutonomyChangeRow,
  AutonomyDomain,
  AutonomyDomainView,
  AutonomyHistoryPage,
  AutonomyLevel,
  AutonomyPage as AutonomyData,
  AutonomySetRequest,
  AutonomySetResponse,
} from '../../../../src/dashboard/autonomy-types';
import type { StreamMessage } from '../../../../src/dashboard/types';
import { api, send, useApi } from '../../api';
import type { RouteProps } from '../../routes';
import { useDevMode } from '../../shell/prefs';
import { Button, EmptyState, Page, Section, Skeleton, Table, type Column } from '../../ui';
import { changeError, LevelChoice, LevelPill, Legend, RaiseConfirm, rank, TaintNote, When, who } from './parts';
import './autonomy.css';

// the trust ladder (docs/DESIGN-NEXT.md 13.6). each domain shows its level, and the post of this page is the only
// way to raise one. the agent can lower a level from chat, so the page loads again when a run ends.

const refreshOn = (message: StreamMessage) => message.kind === 'run';

// the state of one card while the owner changes its level. ask holds the raise that waits for a confirm.
interface CardState {
  ask?: AutonomyLevel;
  busy?: boolean;
  error?: string;
}

function DomainCard({
  domain,
  levelText,
  state,
  devMode,
  onPick,
  onConfirm,
  onCancel,
}: {
  domain: AutonomyDomainView;
  levelText: Record<AutonomyLevel, string>;
  state: CardState;
  devMode: boolean;
  onPick: (level: AutonomyLevel) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const capped = !domain.fixed && rank(domain.maxLevel) < rank('auto');
  return (
    <li className="autonomy-card" aria-labelledby={`autonomy-${domain.id}`}>
      <div className="autonomy-card-text">
        <h3 className="autonomy-card-title" id={`autonomy-${domain.id}`}>
          {domain.label}
        </h3>
        <p className="autonomy-card-explanation">{domain.explanation}</p>
        {domain.overriddenBy !== null ? (
          <p className="autonomy-override small" role="note">
            The allow rule <code>{domain.overriddenBy}</code> in okc.policy.json lets these actions run without the review. Remove the rule to make
            the level count.
          </p>
        ) : null}
        {devMode ? (
          <p className="autonomy-tools small muted" aria-label="tools">
            {domain.tools.length ? domain.tools.map((tool) => <code key={tool}>{tool}</code>) : 'no tool yet'}
          </p>
        ) : null}
      </div>
      <div className="autonomy-card-level">
        <div className="autonomy-card-now">
          {/* the radios show the level of a domain that can change, so only a fixed domain shows it as a pill. */}
          {domain.fixed ? <LevelPill level={domain.level} /> : null}
          {domain.fixed ? null : (
            <span className="autonomy-default small">{domain.level === domain.defaultLevel ? 'Default level' : `Default: ${domain.defaultLevel}`}</span>
          )}
          <span className="small muted">{domain.updatedAt ? <>Changed <When iso={domain.updatedAt} /></> : 'Never changed'}</span>
        </div>
        {domain.fixed ? (
          <div className="autonomy-fixed">
            <strong>Always ask</strong>
            {domain.fixedReason ? <span className="small muted">{domain.fixedReason}</span> : null}
          </div>
        ) : (
          <>
            <LevelChoice
              name={`autonomy-${domain.id}-level`}
              label={`${domain.label} level`}
              levels={domain.levels}
              value={domain.level}
              disabled={Boolean(state.busy)}
              onPick={onPick}
            />
            {capped ? <span className="small muted">Can go up to {domain.maxLevel}</span> : null}
          </>
        )}
        {state.ask ? (
          <RaiseConfirm label={domain.label} level={state.ask} text={levelText[state.ask]} busy={Boolean(state.busy)} onConfirm={onConfirm} onCancel={onCancel} />
        ) : null}
        {state.error ? (
          <span role="alert" className="error-text small">
            {state.error}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function History({ data, devMode }: { data: AutonomyData; devMode: boolean }) {
  // the older pages belong to the first page that they follow, so new data drops them and the list starts again.
  const [older, setOlder] = useState<{ of?: AutonomyData; rows: AutonomyChangeRow[]; before: number | null; busy: boolean; error?: string }>({
    rows: [],
    before: null,
    busy: false,
  });
  const current = older.of === data ? older : { rows: [] as AutonomyChangeRow[], before: data.before, busy: false, error: undefined };
  const rows = [...data.history, ...current.rows];
  const labels = new Map(data.domains.map((each) => [each.id, each.label] as [AutonomyDomain, string]));
  const more = () => {
    if (current.before === null) return;
    const of = data;
    setOlder({ of, rows: current.rows, before: current.before, busy: true });
    api<AutonomyHistoryPage>(`/api/autonomy/history?before=${current.before}`).then(
      (page) => setOlder((old) => ({ of, rows: [...(old.of === of ? old.rows : []), ...page.changes], before: page.before, busy: false })),
      (err: Error) => setOlder((old) => ({ ...old, of, busy: false, error: err.message })),
    );
  };
  const change = (row: AutonomyChangeRow) => (
    <span className="autonomy-change">
      {row.fromLevel} <span aria-label="to">→</span> {row.toLevel}
    </span>
  );
  const whoCell = (row: AutonomyChangeRow) => (
    <span className="autonomy-who">
      {who(row)}
      {devMode && row.via === 'chat' && row.runId ? (
        <a className="small" href={`#/runs/${encodeURIComponent(row.runId)}`}>
          run {row.runId.slice(0, 8)}
        </a>
      ) : null}
    </span>
  );
  // a phone hides the last three columns, so the domain cell shows the change, who made it and the note under the
  // label.
  const columns: Array<Column<AutonomyChangeRow>> = [
    {
      key: 'when',
      header: 'When',
      cell: (row) => (
        <span className="autonomy-when">
          <When iso={row.createdAt} />
        </span>
      ),
    },
    {
      key: 'domain',
      header: 'Domain',
      wrap: true,
      cell: (row) => (
        <div className="autonomy-domain-cell">
          <span className="autonomy-domain-name">{labels.get(row.domain) ?? row.domain}</span>
          <div className="autonomy-phone small muted">
            {change(row)}
            {whoCell(row)}
            {row.note ? <span className="autonomy-phone-note">{row.note}</span> : null}
            <TaintNote row={row} />
          </div>
        </div>
      ),
    },
    { key: 'change', header: 'Change', hideBelow: 'sm', cell: change },
    { key: 'who', header: 'Who', wrap: true, hideBelow: 'sm', cell: whoCell },
    {
      key: 'note',
      header: 'Note',
      wrap: true,
      hideBelow: 'sm',
      cell: (row) => (
        <div className="autonomy-note-cell">
          {row.note ?? <span className="muted">-</span>}
          <TaintNote row={row} />
        </div>
      ),
    },
  ];
  return (
    <Section title="History" description="Every change of a level, newest first.">
      <Table
        label="autonomy history"
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.id)}
        empty={
          <EmptyState icon="policy" title="No changes yet">
            Every domain is at its default level.
          </EmptyState>
        }
      />
      {current.before !== null || current.error ? (
        <div className="autonomy-more">
          {current.before !== null ? (
            <Button size="sm" busy={current.busy} onClick={more}>
              Show older
            </Button>
          ) : null}
          {current.error ? (
            <span role="alert" className="error-text autonomy-more-error">
              Could not load older changes. Try again. The server said: {current.error}
            </span>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

function Ladder({ data, reload }: { data: AutonomyData; reload: () => void }) {
  const devMode = useDevMode();
  const [cards, setCards] = useState<Partial<Record<AutonomyDomain, CardState>>>({});
  // the answer of a post shows at once. it belongs to the data that it changed, so the next load replaces it.
  const [answered, setAnswered] = useState<{ of?: AutonomyData; domains: Partial<Record<AutonomyDomain, AutonomyDomainView>> }>({ domains: {} });
  const overrides = answered.of === data ? answered.domains : {};
  const setCard = (id: AutonomyDomain, state: CardState) => setCards((old) => ({ ...old, [id]: state }));

  const post = (domain: AutonomyDomainView, level: AutonomyLevel) => {
    setCard(domain.id, { ...(cards[domain.id]?.ask ? { ask: cards[domain.id]!.ask! } : {}), busy: true });
    const body: AutonomySetRequest = { level, from: domain.level };
    const of = data;
    send<AutonomySetResponse>(`/api/autonomy/${encodeURIComponent(domain.id)}`, 'POST', body).then(
      (answer) => {
        setAnswered((old) => ({ of, domains: { ...(old.of === of ? old.domains : {}), [domain.id]: answer.domain } }));
        setCard(domain.id, {});
        reload();
      },
      (err: Error) => {
        setCard(domain.id, { error: changeError(err.message) });
        // another tab may have changed the level, so the page shows the levels of the server again.
        reload();
      },
    );
  };

  const pick = (domain: AutonomyDomainView, level: AutonomyLevel) => {
    if (rank(level) > rank(domain.level)) setCard(domain.id, { ask: level });
    else post(domain, level);
  };

  const domains = data.domains.map((each) => overrides[each.id] ?? each);
  return (
    <>
      <Legend text={data.levelText} />
      <Section title="Domains" description="Each kind of action has its own level.">
        <ul className="autonomy-cards">
          {domains.map((domain) => {
            const state = cards[domain.id] ?? {};
            return (
              <DomainCard
                key={domain.id}
                domain={domain}
                levelText={data.levelText}
                state={state}
                devMode={devMode}
                onPick={(level) => pick(domain, level)}
                onConfirm={() => state.ask && post(domain, state.ask)}
                onCancel={() => setCard(domain.id, {})}
              />
            );
          })}
        </ul>
      </Section>
      <History data={data} devMode={devMode} />
    </>
  );
}

export function AutonomyPage(_props: RouteProps) {
  const loaded = useApi<AutonomyData>('/api/autonomy', refreshOn);
  return (
    <Page
      title="Autonomy"
      subtitle="What the agent may do on its own. Only you can give it more freedom, here. The agent can take freedom away when you ask in chat."
    >
      {loaded.error ? (
        <div className="error-box autonomy-load-error">
          <p>Could not load: {loaded.error}</p>
          <Button size="sm" onClick={loaded.reload}>
            Try again
          </Button>
        </div>
      ) : loaded.data === undefined ? (
        <Skeleton lines={4} />
      ) : (
        <Ladder data={loaded.data} reload={loaded.reload} />
      )}
    </Page>
  );
}
