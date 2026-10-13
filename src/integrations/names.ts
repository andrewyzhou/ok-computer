import { createHash } from 'node:crypto';

// a provider accepts only these tool names. the integration id has no underscore, so "__" always ends the prefix.
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// the name depends only on the integration id and the server's name of the tool. an approval stores the name and can
// run days later, after a restart or a new catalog, so the same tool must get the same name every time. a name that
// needs a change gets a short hash of the original name, so two names that change to the same text stay apart.
export function toolName(integrationId: string, mcpName: string): string {
  const plain = `${integrationId}__${mcpName}`;
  if (TOOL_NAME.test(plain)) return plain;
  const hash = createHash('sha256').update(mcpName).digest('hex').slice(0, 6);
  const room = 64 - integrationId.length - '__'.length - '_'.length - hash.length;
  const cleaned = mcpName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, Math.max(room, 0));
  return `${integrationId}__${cleaned}_${hash}`;
}

// the integration id of a tool name, or undefined for a built-in tool. built-in names never have "__".
export function integrationOf(name: string): string | undefined {
  const at = name.indexOf('__');
  return at > 0 ? name.slice(0, at) : undefined;
}
