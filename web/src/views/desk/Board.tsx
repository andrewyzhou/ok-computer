import { useState } from 'react';
import type { Delegation, DeskBoard, DeskColumn } from '../../../../src/dashboard/desk-types';
import { clock, plural, time } from '../../format';
import { Badge, Button, Count, Pill } from '../../ui';
import { STATUS_LABEL, personLabel } from './data';

// the columns of the board, one for each status, with a card for each delegation: the title, who it waits on, the
// due time and the next step. a wide board shows the columns side by side. a narrow one stacks them into one list
// with a heading for each status, and folds the done and dropped columns behind a button.
export interface BoardProps {
  board: DeskBoard;
  // the id of the selected delegation, whose card is marked.
  selectedId: number | null;
  onSelect: (id: number) => void;
  // the time that the due words count from, so a test can fix it.
  now?: Date;
}

const DAY_MS = 86_400_000;
const utcMonthDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

// the month and the day of a time in the time zone of the app, for example Oct 16. it is the date part of time() in
// format.ts, so it follows the same time zone.
export function monthDay(at: Date): string {
  return time(at.toISOString()).split(',')[0]!;
}

// the number of the day of a time in the time zone of the app, counted from 1970-01-01. that day is at most one day
// from the utc day, so the one of the three days whose month and day match is the right one.
function dayNumber(at: Date): number {
  const label = monthDay(at);
  const utc = Math.floor(at.getTime() / DAY_MS);
  for (const delta of [0, -1, 1]) if (utcMonthDay.format(new Date((utc + delta) * DAY_MS)) === label) return utc + delta;
  return utc;
}

// the words of a due time on a card, counted from now in the time zone of the app: Due today, Due tomorrow,
// Due Oct 16, or Overdue by 2 days. null when there is no due time.
export function dueWords(dueAt: string | null, now: Date): string | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  const days = dayNumber(due) - dayNumber(now);
  if (due.getTime() < now.getTime()) return days < 0 ? `Overdue by ${plural(-days, 'day')}` : `Overdue since ${clock(dueAt)}`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due ${monthDay(due)}`;
}

const isActive = (delegation: Delegation) => delegation.status !== 'done' && delegation.status !== 'dropped';
const isClosedColumn = (column: DeskColumn) => column.status === 'done' || column.status === 'dropped';

function When({ delegation, now }: { delegation: Delegation; now: Date }) {
  if (!isActive(delegation)) {
    if (!delegation.closedAt) return null;
    return <span className="desk-card-when">{`${STATUS_LABEL[delegation.status]} ${monthDay(new Date(delegation.closedAt))}`}</span>;
  }
  const words = dueWords(delegation.dueAt, now);
  if (!words) return null;
  if (words.startsWith('Overdue')) return <Badge tone="critical">{words}</Badge>;
  return <span className={words === 'Due today' ? 'desk-card-when is-soon' : 'desk-card-when'}>{words}</span>;
}

function Card({ delegation, selected, onSelect, now }: { delegation: Delegation; selected: boolean; onSelect: (id: number) => void; now: Date }) {
  const person = personLabel(delegation);
  const followUpDue = isActive(delegation) && delegation.nextFollowUpAt !== null && Date.parse(delegation.nextFollowUpAt) <= now.getTime();
  return (
    <li>
      <button type="button" className="desk-card" aria-pressed={selected} onClick={() => onSelect(delegation.id)}>
        <span className="desk-card-title desk-clamp" title={delegation.title}>
          {delegation.title}
        </span>
        {person ? (
          <span className="desk-card-person">
            <Pill icon="people" className="desk-person">
              <span className="desk-person-name">{person}</span>
            </Pill>
            {delegation.status === 'waiting' && delegation.waitingSince ? (
              <span className="muted">since {monthDay(new Date(delegation.waitingSince))}</span>
            ) : null}
          </span>
        ) : null}
        <span className="desk-card-meta">
          <When delegation={delegation} now={now} />
          {followUpDue ? <Badge tone="warning">Follow-up due</Badge> : null}
          {delegation.nudgeCount > 0 ? <span className="muted">{plural(delegation.nudgeCount, 'nudge')}</span> : null}
        </span>
        {delegation.nextStep ? <span className="desk-card-next desk-clamp">{delegation.nextStep}</span> : null}
      </button>
    </li>
  );
}

function Column({ column, selectedId, onSelect, now, folded }: { column: DeskColumn; selectedId: number | null; onSelect: (id: number) => void; now: Date; folded: boolean }) {
  const label = STATUS_LABEL[column.status];
  const headingId = `desk-col-${column.status}`;
  const closed = isClosedColumn(column);
  const classes = ['desk-column', `desk-column-${column.status}`, closed ? 'is-closed' : '', closed && folded ? 'is-folded' : ''].filter(Boolean).join(' ');
  return (
    <section className={classes} aria-labelledby={headingId}>
      <h2 className="desk-column-head" id={headingId}>
        {label}
        <Count value={column.total} label="delegations" />
      </h2>
      {column.delegations.length ? (
        <ul className="desk-cards" aria-label={label}>
          {column.delegations.map((delegation) => (
            <Card key={delegation.id} delegation={delegation} selected={delegation.id === selectedId} onSelect={onSelect} now={now} />
          ))}
        </ul>
      ) : (
        <p className="muted desk-none">None</p>
      )}
      {closed && column.total > column.delegations.length ? (
        <p className="muted desk-limit">{`Showing the newest ${column.delegations.length} of ${column.total}`}</p>
      ) : null}
    </section>
  );
}

export function Board({ board, selectedId, onSelect, now = new Date() }: BoardProps) {
  // the done and dropped columns start folded on a narrow board. the css shows them on a wide board in any case, and
  // shows the button only on a narrow one.
  const [showClosed, setShowClosed] = useState(false);
  const closed = board.columns.filter(isClosedColumn);
  // a closed column that holds the selected card opens, so the selection is never hidden, and a board of one column
  // folds nothing.
  const holdsSelected = closed.some((column) => column.delegations.some((each) => each.id === selectedId));
  const foldable = board.columns.length > 1 && closed.length > 0 && !holdsSelected;
  const folded = foldable && !showClosed;
  const counts = closed.map((column) => `${column.total} ${STATUS_LABEL[column.status].toLowerCase()}`).join(', ');
  return (
    <div className={`desk-board desk-board-${board.columns.length === 1 ? 'one' : 'all'}`}>
      {/* the button comes before the columns, so the owner sees that done and dropped are folded without a scroll. */}
      {foldable ? (
        <div className="desk-closed-bar">
          <Button variant="ghost" size="sm" className="desk-closed-toggle" aria-expanded={showClosed} onClick={() => setShowClosed((open) => !open)}>
            {showClosed ? 'Hide done and dropped' : `Show done and dropped (${counts})`}
          </Button>
        </div>
      ) : null}
      <div className="desk-columns">
        {board.columns.map((column) => (
          <Column key={column.status} column={column} selectedId={selectedId} onSelect={onSelect} now={now} folded={folded} />
        ))}
      </div>
    </div>
  );
}
