import { z } from 'zod';
import { defineTool, type Tool } from '../tools/registry.js';
import type { PlaidContext } from './context.js';
import { NOT_BUILT, PLAID_SOURCE } from './names.js';

// the tools of the bank, which are PLAID_TOOLS of names.ts. app.ts registers them with one line. both only read the
// database: no tool calls plaid, links or removes a bank, or moves money. their output holds bank text (merchant names,
// descriptions, institution names), so it is untrusted.

export function createPlaidTools(ctx: PlaidContext): Tool[] {
  void ctx;
  return [
    defineTool({
      name: 'bank_accounts',
      description:
        'List the bank logins that the owner linked, with each account (name, type and the last digits), the status of the login and the time of the last sync. It shows no balance and no transactions. It changes nothing.',
      input: z.object({}),
      risk: 'read',
      untrustedOutput: PLAID_SOURCE,
      async run() {
        throw new Error(NOT_BUILT);
      },
    }),
    defineTool({
      name: 'bank_subscriptions',
      description:
        'List the paid subscriptions that the bank and the receipts in the mail show, one line for each, with the source (bank, receipt or both), the amount, the cadence, the next charge and the open alerts (new, price increase, trial turned into a charge, duplicate, maybe unused). It changes nothing and cannot pay or cancel.',
      input: z.object({ alertsOnly: z.boolean().optional().describe('Only the subscriptions with an open alert.') }),
      risk: 'read',
      untrustedOutput: PLAID_SOURCE,
      async run() {
        throw new Error(NOT_BUILT);
      },
    }),
  ];
}
