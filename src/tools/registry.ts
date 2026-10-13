import { z } from 'zod';
import type { ToolCall, ToolSpec } from '../models/types.js';
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
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  // external means that the tool sends data off the machine or changes an account.
  risk: 'read' | 'write' | 'external';
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolRegistry {
  specs(allowed: readonly string[]): ToolSpec[];
  run(call: ToolCall, allowed: readonly string[], ctx: ToolContext): Promise<ToolOutput>;
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
    async run(call, allowed, ctx) {
      const tool = byName.get(call.name);
      // a tool outside the allowlist is the same as a tool that does not exist.
      if (!tool || !allowed.includes(call.name)) return { content: `unknown tool: ${call.name}`, isError: true };
      const parsed = tool.input.safeParse(call.input);
      if (!parsed.success) return { content: `invalid input for ${call.name}:\n${z.prettifyError(parsed.error)}`, isError: true };
      try {
        return await tool.run(parsed.data, ctx);
      } catch (err) {
        return { content: `${call.name} failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function toSpec(tool: Tool): ToolSpec {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}
