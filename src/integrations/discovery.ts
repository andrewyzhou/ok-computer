import type { CallToolResult } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { headOf } from '../text.js';
import { HANDLE_OVER } from '../tools/results.js';
import { defineTool, TOOL_CALL, type Tool, type ToolOutput } from '../tools/registry.js';
import type { Risk } from '../policy/policy.js';
import type { CatalogTool } from './catalog.js';
import type { CallOutcome } from './mcp.js';

export const TOOL_SEARCH = 'tool_search';

// the answer must stay under the handle limit with its wrapper, or the model gets a cut preview of the list.
export const SEARCH_BUDGET = HANDLE_OVER - 600;
const LIST_DESCRIPTION = 300;

// a visible tool with what the search shows. risk and source come from the config of its integration.
export interface Discoverable {
  tool: CatalogTool;
  risk: Risk;
  // the integration's catalog text is outside text unless the owner trusts that integration.
  untrusted: boolean;
  // why the integration cannot take a call now. it is absent when the integration is connected.
  unavailable?: string;
}

export interface Discovery {
  visible(sessionKey: string, timeZone: string): Discoverable[];
}

// the model can tell the owner before a call that it waits for an approval.
const RISK_TEXT: Record<Risk, string> = {
  read: 'risk read: it runs without approval.',
  write: 'risk write: it is reviewed first, and until a reviewer exists the owner approves each call.',
  external: 'risk external: the owner approves each call.',
};
// a list of names helps the model when no word matched. this limit keeps it well inside the search budget.
const NAMES_LIMIT = 1_500;

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
        return search(discovery.visible(ctx.sessionKey, ctx.timeZone), query, limit);
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
  const untrusted = (list: Discoverable[]) => {
    const ids = [...new Set(list.filter((each) => each.untrusted).map((each) => each.tool.integrationId))];
    return ids.length ? { untrustedSource: `mcp catalog: ${ids.join(', ')}` } : {};
  };
  if (!ranked.length) {
    if (!visible.length) return { content: 'No integration tools are available.' };
    let names = '';
    let shown = 0;
    for (const each of visible) {
      if (names.length + each.tool.name.length + 2 > NAMES_LIMIT) break;
      names += `${shown ? ', ' : ''}${each.tool.name}`;
      shown++;
    }
    const more = visible.length - shown;
    // the names are text of the servers too, so the answer keeps their source.
    return { content: `No tool matched "${query}". The tools are: ${names}${more ? `, and ${more} more` : ''}.`, ...untrusted(visible.slice(0, shown)) };
  }
  const blocks: string[] = [];
  let used = 0;
  let left = 0;
  for (const each of ranked) {
    // $schema picks the dialect of the check. the model does not need it, and it costs room in the budget.
    const { $schema: _dialect, ...shown } = each.tool.inputSchema;
    const schema = JSON.stringify(shown);
    const description = exact ? each.tool.description : headOf(each.tool.description, LIST_DESCRIPTION);
    const status = each.unavailable ? ` Not available now: ${each.unavailable}` : '';
    const head = `${each.tool.name}\nintegration: ${each.tool.integrationId}. ${RISK_TEXT[each.risk]}${status}\n${description}`;
    // an exact name always gets its full schema. a long one then goes through a handle, which the model can page.
    const full = `${head}\ninput schema: ${schema}`;
    const block = exact || used + full.length <= SEARCH_BUDGET ? full : `${head}\ninput schema: ${schema.length} characters; search for the exact name to see it.`;
    if (!exact && used + block.length > SEARCH_BUDGET) {
      left++;
      continue;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  if (left) blocks.push(`${left} more matching tools did not fit. Use other words or a lower limit.`);
  return { content: blocks.join('\n\n'), ...untrusted(ranked) };
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
      if (outcome.answered) {
        return {
          content: `${name} ran on ${server}, but its answer could not be read (${outcome.reason}). It probably acted. Check the result before you try it again.`,
          isError: true,
        };
      }
      return {
        content: `${name} was sent to ${server}, but no answer came (${outcome.reason}). Its effect is unknown. Check the result before you try it again.`,
        isError: true,
      };
  }
}

