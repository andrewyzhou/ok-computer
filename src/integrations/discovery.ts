import type { CallToolResult } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { headOf } from '../text.js';
import { HANDLE_OVER } from '../tools/results.js';
import { defineTool, TOOL_CALL, type Tool, type ToolOutput } from '../tools/registry.js';
import type { CatalogTool } from './catalog.js';
import type { CallOutcome } from './mcp.js';

export const TOOL_SEARCH = 'tool_search';

// the answer must stay under the handle limit with its wrapper, or the model gets a cut preview of the list.
export const SEARCH_BUDGET = HANDLE_OVER - 600;
const LIST_DESCRIPTION = 300;

// a visible tool with what the search shows. risk and source come from the config of its integration.
export interface Discoverable {
  tool: CatalogTool;
  risk: string;
  // the integration's catalog text is outside text unless the owner trusts that integration.
  untrusted: boolean;
  status: string;
}

export interface Discovery {
  visible(sessionKey: string): Discoverable[];
}

// the descriptions are fixed text, so the tools parameter of every request stays the same, whatever the servers do.
export function createDiscoveryTools(discovery: Discovery): Tool[] {
  return [
    defineTool({
      name: TOOL_SEARCH,
      description:
        'Find tools of the connected integrations (for example mail, chat, or calendar services) by words in their name or description. ' +
        'It gives each tool with its risk and its input schema. Search for the exact name of a tool to see its full description and schema. ' +
        'Then use tool_call to run it.',
      input: z.object({
        query: z.string().min(1).max(200).describe('words to look for, or the exact name of a tool'),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      risk: 'read',
      async run({ query, limit }, ctx) {
        return search(discovery.visible(ctx.sessionKey), query, limit);
      },
    }),
    defineTool({
      name: TOOL_CALL,
      description:
        'Run a tool that tool_search found. Give its exact name and its arguments as an object that matches its input schema. ' +
        'The same rules apply as for every other tool: some calls wait for the owner\'s approval.',
      input: z.object({
        name: z.string().min(1).max(64),
        arguments: z.record(z.string(), z.unknown()).default({}),
      }),
      risk: 'read',
      // the registry runs the named tool in place of this one, so the policy and the trace see the real tool.
      async run() {
        return { content: 'tool_call runs only through the tool registry', isError: true };
      },
    }),
  ];
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);

export function search(visible: Discoverable[], query: string, limit: number): ToolOutput {
  const exact = visible.find((each) => each.tool.name === query.trim());
  const ranked = exact
    ? [exact]
    : visible
        .map((each) => {
          const haystack = `${each.tool.name} ${each.tool.mcpName} ${each.tool.description}`.toLowerCase();
          const nameWords = words(each.tool.name);
          const score = words(query).reduce((sum, word) => sum + (nameWords.includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0), 0);
          return { each, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.each.tool.name.localeCompare(b.each.tool.name))
        .slice(0, limit)
        .map(({ each }) => each);
  if (!ranked.length) {
    const total = visible.length;
    return { content: total ? `no tool matches "${query}". ${total} integration tools exist; try other words.` : 'no integration tools are available.' };
  }
  const blocks: string[] = [];
  let used = 0;
  let left = 0;
  for (const each of ranked) {
    const schema = JSON.stringify(each.tool.inputSchema);
    const description = exact ? each.tool.description : headOf(each.tool.description, LIST_DESCRIPTION);
    const head = `${each.tool.name} (risk: ${each.risk}${each.status === 'connected' ? '' : `, server ${each.status}`})\n${description}`;
    // an exact name always gets its full schema. a long one then goes through a handle, which the model can page.
    const full = `${head}\ninput: ${schema}`;
    const block = exact || used + full.length <= SEARCH_BUDGET ? full : `${head}\ninput: ${schema.length} characters; search for the exact name to see it.`;
    if (!exact && used + block.length > SEARCH_BUDGET) {
      left++;
      continue;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  if (left) blocks.push(`${left} more matching tools did not fit. use other words or a lower limit.`);
  const untrusted = [...new Set(ranked.filter((each) => each.untrusted).map((each) => each.tool.integrationId))];
  return { content: blocks.join('\n\n'), ...(untrusted.length ? { untrustedSource: `mcp catalog: ${untrusted.join(', ')}` } : {}) };
}

// the model gets text. content that is not text gets a short line, so the model knows that it exists.
export function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((block) => {
    switch (block.type) {
      case 'text':
        return block.text;
      case 'image':
      case 'audio':
        return `[${block.type} ${block.mimeType}, ${Math.round((block.data.length * 3) / 4)} bytes, not shown]`;
      case 'resource_link':
        return `[resource link: ${block.name} ${block.uri}]`;
      case 'resource':
        return 'text' in block.resource ? block.resource.text : `[resource ${block.resource.uri}, binary, not shown]`;
      default:
        return `[content of type ${(block as { type: string }).type}, not shown]`;
    }
  });
  if (!parts.length && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join('\n');
}

// each outcome says what the model may assume. the words "effect is unknown" match the abandoned call of the caller.
export function outcomeOutput(name: string, server: string, outcome: CallOutcome): ToolOutput {
  switch (outcome.kind) {
    case 'result':
      return { content: resultText(outcome.result), ...(outcome.result.isError ? { isError: true } : {}) };
    case 'not_sent':
      return { content: `${name} did not run: ${outcome.reason}`, isError: true };
    case 'refused':
      return { content: `${name} did not run. ${server} answered with error ${outcome.code}: ${outcome.message}`, isError: true };
    case 'unknown':
      return {
        content: `${name} was sent to ${server}, but no answer came (${outcome.reason}). Its effect is unknown. Check the result before you try it again.`,
        isError: true,
      };
  }
}

