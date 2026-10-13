import { z } from 'zod';
import type { ToolCall, ToolSpec } from '../models/types.js';
import type { Risk } from '../policy/policy.js';
import type { Clock } from '../time.js';

export interface ToolContext {
  runId: string;
  sessionKey: string;
  timeZone: string;
  clock: Clock;
  signal: AbortSignal;
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
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

export type Resolved = { ok: true; tool: Tool; input: unknown } | { ok: false; output: ToolOutput };

export interface ToolRegistry {
  specs(allowed: readonly string[]): ToolSpec[];
  // resolve finds the tool and checks its input. the error output goes back to the model.
  resolve(call: ToolCall, allowed: readonly string[]): Resolved;
  // execute runs a resolved tool. a tool that throws gives an error output. only the tool caller calls it, so every
  // call goes through the policy.
  execute(tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<I>(tool: Tool<I>): Tool<unknown> {
  return tool as Tool<unknown>;
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // the tool list is part of the cached prefix, so the order must not change between requests.
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const specs = new Map(sorted.map((tool) => [tool.name, toSpec(tool)]));

  return {
    specs(allowed) {
      return sorted.filter((tool) => allowed.includes(tool.name)).map((tool) => specs.get(tool.name)!);
    },
    resolve(call, allowed) {
      const tool = byName.get(call.name);
      // a tool outside the allowlist is the same as a tool that does not exist.
      if (!tool || !allowed.includes(call.name)) return { ok: false, output: { content: `unknown tool: ${call.name}`, isError: true } };
      const parsed = tool.input.safeParse(call.input);
      if (!parsed.success) {
        return { ok: false, output: { content: `invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`, isError: true } };
      }
      return { ok: true, tool, input: parsed.data };
    },
    async execute(tool, input, ctx) {
      try {
        return await tool.run(input, ctx);
      } catch (err) {
        return { content: `${tool.name} failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function toSpec(tool: Tool): ToolSpec {
  // the input mode shows a field with a default as optional, because the model can leave it out.
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}
