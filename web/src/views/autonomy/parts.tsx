import { useEffect, useRef } from 'react';
import type { AutonomyChangeRow, AutonomyLevel } from '../../../../src/dashboard/autonomy-types';
import { time } from '../../format';
import { Button, Pill } from '../../ui';

// the small parts of the autonomy page: the order of the levels, the words of a change and the controls of a card.

// the order of trust, as in src/policy/autonomy.ts. a higher index is more freedom.
export const LEVELS: AutonomyLevel[] = ['ask', 'review', 'auto'];

export const rank = (level: AutonomyLevel): number => LEVELS.indexOf(level);

const LEVEL_NAME: Record<AutonomyLevel, string> = { ask: 'Ask', review: 'Review', auto: 'Auto' };

// the time since a change in short words, for example 5 min ago. an older change shows its day and time.
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return '-';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return time(iso);
}

// a time as a short relative text, with the full time as its title.
export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={time(iso)}>
      {ago(iso)}
    </time>
  );
}

// who made a change, in plain words. only the owner on the dashboard raises a level, and the agent lowers one in chat.
export function who(row: AutonomyChangeRow): string {
  return row.actor === 'owner' ? 'You, on the dashboard' : 'The agent, in chat';
}

export function LevelPill({ level }: { level: AutonomyLevel }) {
  return <Pill className={`autonomy-level autonomy-level-${level}`}>{level}</Pill>;
}

// the three levels with their meaning, above the cards.
export function Legend({ text }: { text: Record<AutonomyLevel, string> }) {
  return (
    <dl className="autonomy-legend" aria-label="levels">
      {LEVELS.map((level) => (
        <div key={level} className="autonomy-legend-item">
          <dt>
            <LevelPill level={level} />
          </dt>
          <dd>{text[level]}</dd>
        </div>
      ))}
    </dl>
  );
}

// the levels that the owner can choose, as one segmented row of radios. the radio of the current level is checked.
// a choice calls onPick, and the page decides to send it at once or to ask first.
export function LevelChoice({
  name,
  label,
  levels,
  value,
  disabled,
  onPick,
}: {
  name: string;
  label: string;
  levels: AutonomyLevel[];
  value: AutonomyLevel;
  disabled: boolean;
  onPick: (level: AutonomyLevel) => void;
}) {
  return (
    <div className="autonomy-choice" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {levels.map((level) => (
        <label key={level} className={`autonomy-option${level === value ? ' is-on' : ''}`}>
          <input
            type="radio"
            name={name}
            value={level}
            checked={level === value}
            disabled={disabled}
            onChange={() => level !== value && onPick(level)}
          />
          <span>{LEVEL_NAME[level]}</span>
        </label>
      ))}
    </div>
  );
}

// the question before a raise. it takes the focus, so the owner can confirm or cancel with the keyboard.
export function RaiseConfirm({
  label,
  level,
  text,
  busy,
  onConfirm,
  onCancel,
}: {
  label: string;
  level: AutonomyLevel;
  text: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelector<HTMLButtonElement>('button')?.focus(), []);
  return (
    <div ref={box} className="autonomy-confirm" role="group" aria-label={`Confirm ${label} at ${level}`}>
      <p className="autonomy-confirm-text">
        Let the agent {label.toLowerCase()} at {level}? {text}
      </p>
      <div className="autonomy-confirm-actions">
        <Button variant="primary" size="sm" busy={busy} onClick={onConfirm}>
          Confirm
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
