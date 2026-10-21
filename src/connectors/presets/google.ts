import type { Db } from '../../db/index.js';
import type { Google } from '../../google/google.js';
import { notBuilt } from '../not-built.js';
import type { ConnectorContext, ConnectorDef } from '../types.js';

// the google card of the hub. google keeps its own page (#/google) and its own sign-in in src/google/, so the card
// reads the accounts from google_accounts and links to the page for each change. without a google block in the config
// the card is unavailable and says how to add one.
export interface GoogleConnectorDeps {
  db: Db;
  google?: Pick<Google, 'accounts'>;
}

export function googleConnector(deps: GoogleConnectorDeps): ConnectorDef {
  void deps;
  const stub = (_ctx: ConnectorContext): never => notBuilt('the google connector');
  return {
    id: 'google',
    name: 'Google',
    icon: 'google',
    summary: 'Read and label your mail, save drafts, and read your calendar. Nothing is ever sent.',
    kind: 'native',
    pageHash: '#/google',
    setup: async (ctx) => stub(ctx),
    status: async (ctx) => stub(ctx),
    connect: async (ctx) => stub(ctx),
    disconnect: async (ctx) => stub(ctx),
    test: async (ctx) => stub(ctx),
    tools: async (ctx) => stub(ctx),
  };
}
