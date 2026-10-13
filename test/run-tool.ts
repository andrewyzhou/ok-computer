import type { ToolCall } from '../src/models/types.js';
import type { ToolContext, ToolOutput, ToolRegistry } from '../src/tools/registry.js';

// a unit test drives one tool without the policy. the app has no such path: every call goes through the tool caller.
export async function runTool(registry: ToolRegistry, call: ToolCall, allowed: readonly string[], ctx: ToolContext): Promise<ToolOutput> {
  const resolved = registry.resolve(call, allowed);
  return resolved.ok ? registry.execute(resolved.tool, resolved.input, ctx) : resolved.output;
}
