import { z } from 'zod';
import type { ToolCall, ToolSpec } from '../models/types.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import type { Risk } from '../policy/policy.js';
import type { Clock } from '../time.js';

export interface ToolContext {
  runId: string;
  sessionKey: string;
  timeZone: string;
  clock: Clock;
  signal: AbortSignal;
  // the tool caller sets the id of the model's tool call. traces and log lines use it to find the call.
  toolCallId?: string;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  // a tool that returns text from outside the owner names its source here. the tool caller wraps the text as
  // untrusted and marks the session as tainted.
  untrustedSource?: string;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  // external means that the tool sends data off the machine or changes an account.
  risk: Risk;
  // an external tool always needs approval. this flag also asks for approval on other tools.
  needsApproval?: boolean;
  // the source of all outputs of a tool that returns outside text. the registry marks each output with it, also an
  // error, because the message of an error can contain outside text, for example an http body.
  untrustedOutput?: string;
  // the trace columns of a tool that an integration gives, for example 'mcp' and the integration id.
  source?: string;
  serverId?: string;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

// call is the call that runs. it differs from the model's call when tool_call names an integration tool: the policy,
// the approval and the trace then see that tool and its arguments, never tool_call. unknown marks a name that no tool
// of the session has, so an approved call can say that its tool is gone. a failed tool_call carries the call that it
// names, so the trace row names the integration tool too.
// tool is the tool that the call found, when only its input was wrong.
export type Resolved =
  | { ok: true; tool: Tool; input: unknown; call: ToolCall }
  | { ok: false; output: ToolOutput; unknown?: true; call?: ToolCall; tool?: Tool };

export const TOOL_CALL = 'tool_call';

// an integration tool is not in the tools parameter. the model reaches it through tool_call, and an approval reaches it
// by its name. the lookup gives undefined for a name that no integration offers to the session now, so an approval
// made days earlier checks the session profile of the current config again.
export type DynamicTools = (name: string, sessionKey: string) => Tool | undefined;

export interface ToolRegistry {
  specs(allowed: readonly string[]): ToolSpec[];
  // resolve finds the tool and checks its input. the error output goes back to the model.
  resolve(call: ToolCall, allowed: readonly string[], sessionKey: string): Resolved;
  // execute runs a resolved tool. a tool that throws gives an error output, and the log gets the stack. only the tool
  // caller calls it, so every call goes through the policy.
  execute(tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<I>(tool: Tool<I>): Tool<unknown> {
  return tool as Tool<unknown>;
}

export function createToolRegistry(tools: Tool[], logger: Logger = silentLogger, dynamic?: DynamicTools): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // the tool list is part of the cached prefix, so the order must not change between requests.
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const specs = new Map(sorted.map((tool) => [tool.name, toSpec(tool)]));

  const resolveOne = (call: ToolCall, allowed: readonly string[], sessionKey: string): Resolved => {
    const tool = byName.get(call.name) ?? dynamic?.(call.name, sessionKey);
    // a tool outside the allowlist is the same as a tool that does not exist.
    if (!tool || !allowed.includes(call.name)) return { ok: false, output: { content: `unknown tool: ${call.name}`, isError: true }, unknown: true };
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      // the schema of an integration tool comes from its server, and the message of the check quotes it, for example
      // the name of a required property. so the message is outside text, as the output of the tool is.
      const outside = !byName.has(tool.name) && tool.untrustedOutput ? { untrustedSource: tool.untrustedOutput } : {};
      return { ok: false, output: { content: `invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`, isError: true, ...outside }, tool };
    }
    return { ok: true, tool, input: parsed.data, call };
  };

  return {
    specs(allowed) {
      return sorted.filter((tool) => allowed.includes(tool.name)).map((tool) => specs.get(tool.name)!);
    },
    resolve(call, allowed, sessionKey) {
      if (call.name === TOOL_CALL && dynamic && allowed.includes(TOOL_CALL)) {
        const outer = byName.get(TOOL_CALL)?.input.safeParse(call.input);
        if (!outer?.success) {
          return { ok: false, output: { content: `invalid input for ${TOOL_CALL}:\n${outer ? z.prettifyError(outer.error) : 'no schema'}`, isError: true } };
        }
        const { name, arguments: args } = outer.data as { name: string; arguments: unknown };
        // only an integration tool goes through tool_call. a built-in tool has its own entry in the tools parameter.
        const inner = { id: call.id, name, input: args };
        if (byName.has(name) || !dynamic(name, sessionKey) || !allowed.includes(name)) {
          return { ok: false, output: { content: `no integration tool is named ${name}. Use tool_search to find the tool and its exact name.`, isError: true }, call: inner };
        }
        const resolved = resolveOne(inner, allowed, sessionKey);
        return resolved.ok ? resolved : { ...resolved, call: inner };
      }
      return resolveOne(call, allowed, sessionKey);
    },
    async execute(tool, input, ctx) {
      let output: ToolOutput;
      try {
        output = await tool.run(input, ctx);
      } catch (err) {
        // the model gets only the message. the stack goes to the log with the ids of the run and the call.
        logger.error('tool crashed', { tool: tool.name, runId: ctx.runId, toolCallId: ctx.toolCallId, err });
        output = { content: `${tool.name} failed: ${errorText(err)}`, isError: true };
      }
      // a tool from outside, for example an mcp adapter, can give no output or content that is not text. the caller
      // works on text after the tool acted, and a throw there would hide a result.
      if (typeof output?.content !== 'string') {
        logger.warn('tool gave content that is not text', { tool: tool.name, runId: ctx.runId, toolCallId: ctx.toolCallId });
        const content = output?.content;
        output = { ...output, content: content === undefined || content === null ? '' : typeof content === 'object' ? JSON.stringify(content) : String(content) };
      }
      // the same is true for a source that is not text, for example true from a boolean flag, or an empty text from a
      // field that an adapter copied. the output stays untrusted, because a dropped source would hide outside text.
      // only a missing source or false means that the output is trusted.
      const source: unknown = output.untrustedSource;
      if (source !== undefined && source !== null && source !== false && (typeof source !== 'string' || !source.trim())) {
        logger.warn('tool gave an untrusted source that is not text', { tool: tool.name, runId: ctx.runId, toolCallId: ctx.toolCallId });
        const named =
          source === true || typeof source === 'string' ? (tool.untrustedOutput ?? tool.name) : typeof source === 'object' ? JSON.stringify(source) : String(source);
        output = { ...output, untrustedSource: named };
      }
      return tool.untrustedOutput && !output.untrustedSource ? { ...output, untrustedSource: tool.untrustedOutput } : output;
    },
  };
}

// third-party code can throw a value that is not an Error, for example null or a string.
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toSpec(tool: Tool): ToolSpec {
  // the input mode shows a field with a default as optional, because the model can leave it out.
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}
