import type { ConnectionCard, ConnectionDetail, ConnectionsPage, ConnectorStatus } from '../../../../src/dashboard/connectors-types.js';

// the answers of GET /api/connections for the page tests and the screenshots, in the states that each shot needs:
// firstRun (nothing connected), full (one card in each state) and restart (a saved change waits for a restart). the
// texts follow the presets in src/connectors/presets/, so a shot looks like the real page.

const notConnected: ConnectorStatus = { state: 'not_connected', reason: null, reasonAt: null, accounts: [] };

const card = (patch: Partial<ConnectionCard> & Pick<ConnectionCard, 'id' | 'name' | 'icon' | 'summary'>): ConnectionCard => ({
  kind: 'mcp-oauth',
  docsUrl: null,
  pageHash: null,
  status: notConnected,
  setup: [],
  tools: [],
  switches: true,
  ...patch,
});

const GOOGLE = card({
  id: 'google',
  name: 'Google',
  icon: 'google',
  summary: 'Read and label your mail, save drafts, and read your calendar. Nothing is ever sent.',
  kind: 'native',
  pageHash: '#/google',
  switches: false,
});

const GITHUB = card({
  id: 'github',
  name: 'GitHub',
  icon: 'github',
  summary: 'Read your repositories, issues, pull requests and notifications. Opening or changing anything asks you first.',
  docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
  setup: [
    {
      id: 'app',
      title: 'Make an OAuth app on GitHub',
      text: 'Open the developer settings of your GitHub account and choose New OAuth App. Give it any name, and paste this callback address.',
      link: { label: 'Open GitHub developer settings', url: 'https://github.com/settings/developers' },
      copy: [{ label: 'Authorization callback URL', value: 'http://127.0.0.1:4318/oauth/callback' }],
    },
    {
      id: 'client',
      title: 'Paste the client ID and a client secret',
      text: 'They go to the system keyring. No page shows the secret again.',
      fields: [
        { name: 'client_id', label: 'Client ID', secret: false, placeholder: 'Ov23li…' },
        { name: 'client_secret', label: 'Client secret', secret: true },
      ],
    },
  ],
});

const LINEAR = card({
  id: 'linear',
  name: 'Linear',
  icon: 'linear',
  summary: 'Find, read and track your issues and projects. Creating or changing an issue asks you first.',
  docsUrl: 'https://linear.app/docs/mcp',
});

const NOTION = card({
  id: 'notion',
  name: 'Notion',
  icon: 'notion',
  summary: 'Search and read your pages and databases. Creating or changing a page asks you first.',
  docsUrl: 'https://developers.notion.com/docs/mcp',
});

const SLACK = card({
  id: 'slack',
  name: 'Slack',
  icon: 'slack',
  summary: 'Search and read your messages, and check your direct messages every 15 minutes. Each message it sends asks you first.',
  docsUrl: 'https://api.slack.com/apps',
});

const GRANOLA = card({
  id: 'granola',
  name: 'Granola',
  icon: 'granola',
  summary: 'Search your meeting notes and read the notes and transcript of a meeting.',
  docsUrl: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
});

export const firstRun: ConnectionsPage = {
  cards: [GOOGLE, GITHUB, LINEAR, NOTION, SLACK, GRANOLA],
  restartNeeded: false,
  canRestart: true,
};

// a long error, so the shot shows that the card never cuts it.
const LONG_ERROR =
  'the sign-in server answered 400 invalid_grant: The refresh token is invalid, expired or revoked. It was issued to another client, or the owner removed the access of this app in the settings of the workspace. Press Reconnect and sign in again.';

export const full: ConnectionsPage = {
  cards: [
    {
      ...GOOGLE,
      status: {
        state: 'connected',
        reason: null,
        reasonAt: null,
        accounts: [{ id: 'personal', label: 'owner@example.com', detail: 'mail and calendar', connectedAt: '2026-10-01T15:00:00.000Z' }],
      },
    },
    { ...GITHUB, status: { state: 'connecting', reason: null, reasonAt: null, accounts: [], authUrl: 'https://github.com/login/oauth/authorize?client_id=demo' } },
    {
      ...LINEAR,
      status: {
        state: 'connected',
        reason: null,
        reasonAt: null,
        accounts: [{ id: 'linear', label: 'Acme workspace', connectedAt: '2026-10-20T18:30:00.000Z' }],
      },
      tools: [
        { name: 'list_issues', description: 'List issues in the workspace.', risk: 'read', enabled: true, riskFrom: 'preset' },
        { name: 'get_issue', description: 'Read one issue with its comments.', risk: 'read', enabled: true, riskFrom: 'preset' },
        { name: 'create_issue', description: 'Create a new issue.', risk: 'external', enabled: true, riskFrom: 'preset' },
        { name: 'delete_comment', description: 'Delete a comment.', risk: 'external', enabled: false, riskFrom: 'default' },
      ],
    },
    { ...NOTION, status: { state: 'error', reason: LONG_ERROR, reasonAt: '2026-10-21T15:40:00.000Z', accounts: [] } },
    {
      ...SLACK,
      status: {
        state: 'needs_sign_in',
        reason: 'Slack wants you to sign in again. The server said: token_revoked',
        reasonAt: '2026-10-21T09:10:00.000Z',
        accounts: [{ id: 'slack', label: 'Acme', detail: 'user token', connectedAt: '2026-09-02T17:00:00.000Z' }],
      },
    },
    GRANOLA,
  ],
  restartNeeded: false,
  canRestart: true,
};

export const restart: ConnectionsPage = { ...full, restartNeeded: true };

// a restart that the page cannot do, because no supervisor runs the app.
export const restartManual: ConnectionsPage = { ...full, restartNeeded: true, canRestart: false };

export const linearDetail: ConnectionDetail = {
  card: full.cards[2]!,
  events: [
    { id: 3, connectorId: 'linear', integrationId: 'linear', type: 'tool_changed', detail: { tool: 'delete_comment', enabled: false }, at: '2026-10-20T18:40:00.000Z' },
    { id: 2, connectorId: 'linear', integrationId: 'linear', type: 'connected', detail: {}, at: '2026-10-20T18:30:00.000Z' },
    { id: 1, connectorId: 'linear', integrationId: 'linear', type: 'connect_started', detail: {}, at: '2026-10-20T18:29:00.000Z' },
  ],
  calls: [
    { id: 12, toolName: 'linear__list_issues', at: '2026-10-21T14:02:00.000Z', isError: false, outcome: 'ran' },
    { id: 11, toolName: 'linear__create_issue', at: '2026-10-21T13:55:00.000Z', isError: false, outcome: 'waits for you' },
  ],
};
