import type { RunSpans, Span } from '../../../../src/dashboard/types';

// a trace of run-1 of the seeded database. the model and tool ids are the real rows of run-1, so the inspectors load
// the seeded bodies. the spans endpoint is built in parallel, so the tests stub it with this.

const START = '2026-10-13T01:00:00.000Z';
const at = (ms: number | null) => (ms === null ? null : new Date(Date.parse(START) + ms).toISOString());

function span(id: string, parentId: string | null, startMs: number, endMs: number | null, rest: Partial<Span> & Pick<Span, 'kind' | 'label' | 'ref'>): Span {
  return {
    id,
    parentId,
    startAt: at(startMs)!,
    endAt: at(endMs),
    startMs,
    endMs,
    status: null,
    error: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    ...rest,
  };
}

export function runOneSpans(): RunSpans {
  return {
    runId: 'run-1',
    startedAt: START,
    endedAt: at(1000),
    durationMs: 1000,
    costUsd: 0.00133,
    spans: [
      span('run:run-1', null, 0, 1000, { kind: 'run', label: 'message run', status: 'completed', costUsd: 0.00133, ref: { kind: 'run', runId: 'run-1' } }),
      span('model:1', 'run:run-1', 0, 400, {
        kind: 'model',
        label: 'fake/m',
        status: 'tool_use',
        costUsd: 0.00015,
        inputTokens: 100,
        outputTokens: 10,
        ref: { kind: 'model', modelCallId: 1 },
      }),
      span('tool:1', 'model:1', 400, 450, { kind: 'tool', label: 'goals_set', status: 'ran', ref: { kind: 'tool', toolCallRowId: 1, toolCallId: 'call-goals' } }),
      span('tool:2', 'model:1', 450, 470, {
        kind: 'tool',
        label: 'goal_update',
        status: 'failed',
        error: 'no goal has the id 99',
        ref: { kind: 'tool', toolCallRowId: 2, toolCallId: 'call-bad' },
      }),
      span('approval:1', 'run:run-1', 480, null, { kind: 'approval', label: 'now', status: 'pending', ref: { kind: 'approval', approvalId: 1 } }),
      span('subagent:call-sub', 'run:run-1', 500, 900, {
        kind: 'subagent',
        label: 'research',
        status: 'completed',
        ref: { kind: 'subagent', childRunId: 'run-child' },
      }),
      span('run:run-child', 'subagent:call-sub', 510, 890, { kind: 'run', label: 'subagent run', status: 'completed', ref: { kind: 'run', runId: 'run-child' } }),
      span('model:99', 'run:run-child', 520, 600, { kind: 'model', label: 'fake/child', status: 'end_turn', ref: { kind: 'model', modelCallId: 99 } }),
      span('model:2', 'run:run-1', 900, 1000, {
        kind: 'model',
        label: 'fake/m',
        status: 'end_turn',
        costUsd: 0.00118,
        inputTokens: 900,
        outputTokens: 40,
        ref: { kind: 'model', modelCallId: 2 },
      }),
    ],
  };
}
