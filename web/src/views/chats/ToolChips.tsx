import { useEffect, useRef, useState } from 'react';
import type { ToolCallRow } from '../../../../src/dashboard/types';
import { Json } from '../../components';
import { useDevMode } from '../../shell/prefs';
import { CodeBlock, Pill, Status } from '../../ui';
import { loadRun, toolCallsOf } from './data';

// the tools that one turn used, as small chips under the reply. the run loads when the chips come into view, so a long
// transcript does not load every run at once. in developer mode a chip opens the input and the exact output.
export function ToolChips({ runId }: { runId: string }) {
  const devMode = useDevMode();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [calls, setCalls] = useState<ToolCallRow[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    loadRun(runId).then(
      (detail) => current && setCalls(toolCallsOf(detail)),
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [runId, visible]);

  if (error) return null;
  if (!calls) return <div ref={ref} className="chat-chips chat-chips-pending" aria-hidden="true" />;
  if (!calls.length) return null;
  const expanded = devMode ? calls.find((call) => call.id === open) : undefined;
  return (
    <div className="chat-tools">
      <ul className="chat-chips" aria-label="tools used">
        {calls.map((call) => (
          <li key={call.id}>
            <Pill
              className="chat-chip"
              title={devMode ? `show the input and output of ${call.name}` : call.name}
              {...(devMode ? { onClick: () => setOpen(open === call.id ? null : call.id), pressed: open === call.id } : {})}
            >
              <span className="chat-chip-name">{call.name}</span>
              <Status value={call.outcome} />
            </Pill>
          </li>
        ))}
      </ul>
      {expanded ? (
        <div className="chat-tool-detail" aria-label={`tool call ${expanded.name}`} role="group">
          <div className="chat-tool-label">input</div>
          <Json value={expanded.input} />
          <CodeBlock label={expanded.output.isError || expanded.isError ? 'output, an error' : 'output'} text={expanded.output.content} maxHeight={320} />
        </div>
      ) : null}
    </div>
  );
}
