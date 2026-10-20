import { z } from 'zod';
import type { Slot } from '../config/schema.js';
import { getRunDetail } from '../dashboard/queries.js';
import type { Db } from '../db/index.js';
import { DOC_READ_TOOLS } from '../docs/names.js';
import { listEvents } from '../events/log.js';
import { SUBAGENT_PREFIX, type TaintSource } from '../policy/policy.js';
import { decisionForApproval, sessionTaint } from '../policy/store.js';
import type { RunQueue } from '../sessions/queue.js';
import { NO_REPLY } from '../sessions/router.js';
import type { Clock } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import type { RunInput, RunResult } from './loop.js';

export interface Profile {
  description: string;
  // the names of the built-in tools and the google tools. a name that no tool of the app has is left out, for example a
  // google tool when the config has no google block. mcp tools come from okc.integrations.json, with
  // "sessions": ["sub:<profile>"].
  tools: readonly string[];
  slot: Slot;
  maxIterations: number;
}

// the profiles are code, not config: an integration already adds its tools to a profile through its sessions field,
// and a built-in tool needs a code change anyway. no profile has delegate, so a child cannot start a child.
export const PROFILES = {
  browser: {
    description: 'Works in the browser on sites without an API, and reports what it found.',
    tools: ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_back', 'browser_extract', 'browser_close', 'web_fetch', 'result_read'],
    slot: 'main',
    maxIterations: 30,
  },
  research: {
    description: "Searches the web and the owner's memory, and reports an answer with its sources.",
    tools: ['web_search', 'web_fetch', 'memory_search', 'memory_get', 'result_read', ...DOC_READ_TOOLS],
    slot: 'main',
    maxIterations: 20,
  },
  inbox: {
    description: 'Reads, labels and archives mail in bulk, and reports what it did.',
    tools: ['google__gmail_search', 'google__gmail_read_thread', 'google__gmail_list_labels', 'google__gmail_label', 'google__gmail_archive', 'google__gmail_mark_read', 'result_read'],
    slot: 'batch',
    maxIterations: 40,
  },
} as const satisfies Record<string, Profile>;

export type ProfileName = keyof typeof PROFILES;
const NAMES = Object.keys(PROFILES) as [ProfileName, ...ProfileName[]];

export const SUBAGENT_INSTRUCTIONS = `You are a sub-agent. The parent agent gave you one task in a system event. Do the task with your tools, then reply with the result as your final text. The parent agent reads that text; the owner does not see it. You cannot talk with the owner, and a call that needs the owner's approval does not run for you, so name such a call in your result and the parent agent can make it. Keep the result short and factual, and name the source of each fact.`;

export const MAX_CHILDREN = 3;

// result_read only reads a long result of another tool. a profile with only this tool cannot do its task.
const HELPERS: ReadonlySet<string> = new Set(['result_read']);
const canWork = (tools: string[]) => tools.some((name) => !HELPERS.has(name));

export const profileOf = (sessionKey: string): Profile | undefined =>
  sessionKey.startsWith(SUBAGENT_PREFIX) ? (PROFILES as Record<string, Profile>)[sessionKey.split(':')[1] ?? ''] : undefined;

export interface DelegateDeps {
  db: Db;
  clock: Clock;
  queue: RunQueue;
  newId: () => string;
  // the tools of a profile that the app has, with the integration tools of its session. the description lists them
  // when the app starts, so the tools parameter of a session never changes.
  toolsOf: (profile: ProfileName) => string[];
  runChild: (input: RunInput) => Promise<RunResult>;
}

export function createDelegateTool(deps: DelegateDeps): Tool {
  const { db, clock } = deps;
  // the number of children that each parent run has now. a parent run lives in one process, so memory is exact.
  const running = new Map<string, number>();
  const lines = NAMES.map((name) => {
    const tools = deps.toolsOf(name);
    return `- ${name}: ${PROFILES[name].description} Tools: ${canWork(tools) ? tools.join(', ') : 'none in this app yet'}.`;
  });
  return defineTool({
    name: 'delegate',
    description:
      'Give one task to a sub-agent. It works alone with the tools of its profile and a fresh context, and its final text is the result. ' +
      `It does not see this conversation, so write a task that stands alone. At most ${MAX_CHILDREN} sub-agents of one run work at the same time. ` +
      `A sub-agent cannot ask the owner for approval: make such a call yourself. Profiles:\n${lines.join('\n')}`,
    input: z.object({ profile: z.enum(NAMES), task: z.string().min(1).max(8000) }),
    // the tool itself changes nothing. each tool call of the child gets its own policy decision.
    risk: 'read',
    async run({ profile, task }, ctx) {
      if (ctx.sessionKey.startsWith(SUBAGENT_PREFIX)) return { content: 'A sub-agent cannot start another sub-agent.', isError: true };
      const chosen = PROFILES[profile];
      const tools = deps.toolsOf(profile);
      if (!canWork(tools)) return { content: `The ${profile} profile has no tools in this app yet, so no sub-agent started.`, isError: true };
      const count = running.get(ctx.runId) ?? 0;
      // a wait would hold the turn of the parent with no result, so a fourth child gets an answer at once.
      if (count >= MAX_CHILDREN) return { content: `${MAX_CHILDREN} sub-agents of this run already work. Wait for a result, then try again.`, isError: true };
      running.set(ctx.runId, count + 1);
      try {
        const runId = deps.newId();
        const sessionKey = `${SUBAGENT_PREFIX}${profile}:${runId}`;
        // the link comes before the child run, so a crash during the child still shows which call started it.
        db.prepare('INSERT INTO subagent_runs (parentRunId, toolCallId, childRunId, profile, createdAt) VALUES (?, ?, ?, ?, ?)').run(
          ctx.runId,
          ctx.toolCallId ?? '',
          runId,
          profile,
          clock().toISOString(),
        );
        // the child starts as tainted as its parent, because the parent wrote the task after it read outside text.
        // the task is not wrapped: it is the instruction of the child. the policy guards each call of the child.
        const inherited = taintOfTask(db, ctx.sessionKey, ctx.toolCallId);
        const result = await deps.queue.enqueue(sessionKey, () =>
          deps.runChild({
            runId,
            sessionKey,
            trigger: 'subagent',
            slot: chosen.slot,
            channel: 'subagent',
            allowedTools: tools,
            maxIterations: chosen.maxIterations,
            events: [{ type: 'system_event', payload: { text: `Your task from the parent agent:\n${task}`, ...(inherited.length ? { taint: inherited } : {}) } }],
            signal: ctx.signal,
          }),
        );
        // the result is text that the child wrote after it read its sources, so it carries their taint to the parent.
        // the source names the child run, where the full provenance is, and only the sources that the child read
        // itself. the parent already has the inherited sources. if the source repeated them, each delegate call in a
        // tainted session would double the length of the newest source.
        const taint = sessionTaint(db, sessionKey);
        const parentSources = new Set(inherited.map((each) => each.source));
        const own = taint.map((each) => each.source).filter((source) => !parentSources.has(source));
        const untrusted = taint.length ? { untrustedSource: own.length ? `${sessionKey} (${own.join(', ')})` : sessionKey } : {};
        if (result.status === 'completed') {
          // the base instructions tell each session to answer NO_REPLY when it has nothing to say. the parent must not
          // repeat that word, because the owner then gets no reply.
          const text = result.text.trim();
          return { content: text && text !== NO_REPLY ? text : `The ${profile} sub-agent gave no answer.`, ...untrusted };
        }
        return { content: stoppedReport(db, profile, sessionKey, result), isError: true, ...untrusted };
      } finally {
        const left = (running.get(ctx.runId) ?? 1) - 1;
        if (left) running.set(ctx.runId, left);
        else running.delete(ctx.runId);
      }
    },
  });
}

// an approved call can run after /new, when the session is clean. the model wrote the task before that, so the taint
// is the snapshot of the decision that the owner approved, as for the note of the approval.
function taintOfTask(db: Db, sessionKey: string, toolCallId: string | undefined): TaintSource[] {
  const approval = /^approval-(\d+)$/.exec(toolCallId ?? '');
  const decision = approval ? decisionForApproval(db, Number(approval[1])) : undefined;
  return decision ? decision.taint : sessionTaint(db, sessionKey);
}

// a child that stops reports what it has: its last text, and each tool call with its outcome, so the parent does not
// repeat an action that ran.
function stoppedReport(db: Db, profile: string, sessionKey: string, result: RunResult): string {
  const last = listEvents(db, sessionKey)
    .flatMap((event) => (event.type === 'assistant_message' && event.payload.text.trim() ? [event.payload.text.trim()] : []))
    .at(-1);
  const calls = (getRunDetail(db, result.runId)?.timeline ?? [])
    .flatMap((item) => (item.kind === 'model' ? item.tools : [item.call]))
    .map((call) => `${call.name} (${call.outcome})`);
  return [
    `The ${profile} sub-agent (run ${result.runId}) stopped before it finished: ${result.error ?? result.status}.`,
    ...(last ? [`Its last text:\n${last}`] : []),
    `Its tool calls: ${calls.length ? calls.join(', ') : 'none'}.`,
  ].join('\n');
}
