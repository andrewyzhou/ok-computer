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
  // an external tool always needs approval. this flag also asks for approval on other tools.
  needsApproval?: boolean;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

// the gate gets each call of a tool that needs approval. the tool does not run until the owner approves it.
export type ApprovalGate = (tool: Tool, input: unknown, ctx: ToolContext) => Promise<ToolOutput>;

export interface ToolRegistry {
  specs(allowed: readonly string[]): ToolSpec[];
  run(call: ToolCall, allowed: readonly string[], ctx: ToolContext): Promise<ToolOutput>;
  // runApproved runs a tool after the owner approved the call.
  runApproved(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<I>(tool: Tool<I>): Tool<unknown> {
  return tool as Tool<unknown>;
}

export function needsApproval(tool: Tool): boolean {
  return tool.risk === 'external' || tool.needsApproval === true;
}

export function createToolRegistry(tools: Tool[], options: { gate?: ApprovalGate } = {}): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // the tool list is part of the cached prefix, so the order must not change between requests.
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const specs = new Map(sorted.map((tool) => [tool.name, toSpec(tool)]));

  const execute = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolOutput> => {
    try {
      return await tool.run(input, ctx);
    } catch (err) {
      return { content: `${tool.name} failed: ${(err as Error).message}`, isError: true };
    }
  };

  const parse = (tool: Tool, input: unknown) => {
    const parsed = tool.input.safeParse(input);
    return parsed.success
      ? ({ ok: true, value: parsed.data } as const)
      : ({ ok: false, output: { content: `invalid input for ${tool.name}:\n${z.prettifyError(parsed.error)}`, isError: true } } as const);
  };

  return {
    specs(allowed) {
      return sorted.filter((tool) => allowed.includes(tool.name)).map((tool) => specs.get(tool.name)!);
    },
    async run(call, allowed, ctx) {
      const tool = byName.get(call.name);
      // a tool outside the allowlist is the same as a tool that does not exist.
      if (!tool || !allowed.includes(call.name)) return { content: `unknown tool: ${call.name}`, isError: true };
      const parsed = parse(tool, call.input);
      if (!parsed.ok) return parsed.output;
      if (needsApproval(tool)) {
        if (!options.gate) return { content: `${tool.name} needs approval, but approvals are not available`, isError: true };
        return options.gate(tool, parsed.value, ctx);
      }
      return execute(tool, parsed.value, ctx);
    },
    async runApproved(name, input, ctx) {
      const tool = byName.get(name);
      if (!tool) return { content: `unknown tool: ${name}`, isError: true };
      const parsed = parse(tool, input);
      return parsed.ok ? execute(tool, parsed.value, ctx) : parsed.output;
    },
  };
}

function toSpec(tool: Tool): ToolSpec {
  // the input mode shows a field with a default as optional, because the model can leave it out.
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema };
}
