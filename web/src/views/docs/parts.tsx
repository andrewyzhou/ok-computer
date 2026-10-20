import { time } from '../../format';
import { Badge, Button, ButtonLink } from '../../ui';
import './parts.css';

// the small parts that the docs views share: the time of a change, the badge of a tainted doc and the error block.

// the docs views show a time to the minute. the shared time() of format.ts keeps its seconds for the trace and the
// logs, so the docs drop them here.
export function docTime(iso: string | null | undefined): string {
  return time(iso).replace(/(\d{2}:\d{2}):\d{2}$/, '$1');
}

export const TAINT_TITLE = 'The writer of this doc had read untrusted content, such as a web page or a mail, so its text can repeat outside text.';

// the amber badge of a doc or a version that a tainted session wrote. the list, the chat card and the version history
// show the same word, so its meaning never rests on a color or a tooltip.
export function TaintBadge({ tainted, title = TAINT_TITLE }: { tainted: boolean; title?: string }) {
  if (!tainted) return null;
  return (
    <Badge tone="warning" title={title}>
      outside text
    </Badge>
  );
}

// the error of a docs view that did not load: a full-width box and a Try again button with the refresh icon. the list,
// the doc and the diff show the same block. back is the href of a way out, such as the list for a doc that failed.
export function ErrorBlock({ what, error, onRetry, busy, back }: { what: string; error: string; onRetry: () => void; busy?: boolean; back?: { href: string; label: string } }) {
  return (
    <div className="docs-error">
      <p className="error-box" role="alert">
        Could not load {what}: {error}
      </p>
      <div className="docs-error-actions">
        <Button size="sm" icon="refresh" busy={busy} onClick={onRetry}>
          Try again
        </Button>
        {back ? (
          <ButtonLink href={back.href} size="sm">
            {back.label}
          </ButtonLink>
        ) : null}
      </div>
    </div>
  );
}
