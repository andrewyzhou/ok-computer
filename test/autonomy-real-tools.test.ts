import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserWorker } from '../src/browser/worker.js';
import { createGoogleTools } from '../src/google/tools.js';
import type { InboxContext } from '../src/inbox/context.js';
import { createDraftTools } from '../src/inbox/drafts.js';
import { createNewsletterTools } from '../src/inbox/newsletters.js';
import { createBrowserTools } from '../src/browser/tools.js';
import { DOMAINS, domainOf } from '../src/policy/autonomy.js';
import { createSandboxExecTool, SANDBOX_EXEC } from '../src/sandbox/tool.js';
import type { SandboxToolDeps } from '../src/sandbox/tool.js';
import type { Tool } from '../src/tools/registry.js';
import { LADDER_CALLS } from './autonomy-calls.js';
import { createGoogleHarness, type GoogleHarness } from './google-harness.js';

// the equivalence test of the trust ladder decides the calls of LADDER_CALLS with the risk and the approval flag that
// the file gives for each call. these tests build the real tools and check that the file says what the tools say, so
// the golden verdicts are the verdicts of the real calls and not of a copy that drifted. the tools are only built and
// their inputs parsed here: no tool runs, so the fake deps are never read.

let h: GoogleHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function realTools(): Promise<Map<string, Tool>> {
  h = await createGoogleHarness({ accounts: ['personal'] });
  const fake = {} as never;
  const inbox = { googleConfig: h.config } as unknown as InboxContext;
  const tools: Tool[] = [
    ...createGoogleTools({ accounts: h.accounts, config: { ...h.config, send: true }, logger: h.logger }),
    ...createDraftTools(inbox),
    ...createNewsletterTools(inbox),
    ...createBrowserTools(fake as BrowserWorker),
    createSandboxExecTool({ clock: () => new Date(), live: new Set() } as unknown as SandboxToolDeps),
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

// the risk and the approval flag as the tool caller computes them (src/tools/caller.ts, check).
function callerView(tool: Tool, input: unknown) {
  const risk = tool.riskFor?.(input) ?? tool.risk;
  return { risk, alwaysApprove: tool.needsApproval === true || (tool.riskFor !== undefined && risk === 'external') };
}

describe('the shared calls of the ladder against the real tools', () => {
  it('name the risk and the approval flag that the real tool gives, for a parsed input', async () => {
    const tools = await realTools();
    let checked = 0;
    for (const call of LADDER_CALLS) {
      const tool = tools.get(call.tool);
      if (!tool) continue;
      const parsed = tool.input.safeParse(call.input);
      // an input that the tool refuses never reaches the policy, so its golden verdict would prove nothing.
      if (!parsed.success) continue;
      expect(callerView(tool, parsed.data), call.name).toEqual({ risk: call.risk, alwaysApprove: call.alwaysApprove });
      // the caller gives domainOf the parsed input, so the domain must hold for it too.
      expect(domainOf(tool.name, parsed.data) ?? null, call.name).toBe(call.domain);
      checked++;
    }
    // the google, inbox, browser and sandbox calls of the list are all checked.
    expect(checked).toBeGreaterThanOrEqual(14);
  });

  it('cover each tool that a domain lists with a real tool of that name', async () => {
    const tools = await realTools();
    for (const spec of DOMAINS) for (const name of spec.tools) expect(tools.has(name), `${spec.id}: ${name}`).toBe(true);
  });

  it('give the domain of the guests and the risk of an invitation together, for any list of guests that parses', async () => {
    const tools = await realTools();
    const create = tools.get('google__calendar_create_event')!;
    const base = { account: 'personal', summary: 'Focus', start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T11:00:00-07:00' };
    for (const attendees of [undefined, [], ['ana@example.com'], ['ana@example.com', 'bo@example.com']]) {
      const parsed = create.input.safeParse({ ...base, ...(attendees ? { attendees } : {}) });
      expect(parsed.success).toBe(true);
      const view = callerView(create, parsed.data);
      const domain = domainOf(create.name, parsed.data);
      // an event that google sends invitations for is in the fixed domain, and a hold is a plain write.
      expect(domain === 'calendar_guests', JSON.stringify(attendees)).toBe(view.risk === 'external');
      expect(view.alwaysApprove).toBe(domain === 'calendar_guests');
    }
  });

  it('give the network domain and the risk of a network call together, for any network part that parses', async () => {
    const tools = await realTools();
    const exec = tools.get(SANDBOX_EXEC)!;
    for (const network of [undefined, { allow: ['pypi.org'] }, { allow: ['pypi.org', 'files.pythonhosted.org'] }, { allow: [] }]) {
      const parsed = exec.input.safeParse({ language: 'python', code: 'print(1)', ...(network ? { network } : {}) });
      if (!parsed.success) continue;
      const view = callerView(exec, parsed.data);
      // a call that the caller treats as external must be in the ladder domain, so a raise of another domain cannot
      // change it, and a call in the domain is always one that asks today.
      expect(domainOf(exec.name, parsed.data) === 'sandbox_network', JSON.stringify(network)).toBe(view.risk === 'external');
    }
  });
});
