import { SLACK_POLL_TOOLS } from '../../integrations/config.js';
import type { McpPreset, OwnerAppGuide } from '../mcp-preset.js';
import { notBuilt } from '../not-built.js';

// the user token scopes of the slack app of the owner (docs/setup/slack.md). the app asks slack for exactly this list,
// so the guide shows the same list with a copy button.
export const SLACK_SCOPES = ['search:read.im', 'search:read.mpim', 'im:history', 'mpim:history', 'users:read', 'chat:write'];

// the guide of the slack app of the owner. slack accepts only an https redirect, so the sign-in ends on an error page
// of 127.0.0.1, and the owner pastes its address on the card.
export const SLACK_APP: OwnerAppGuide = {
  clientRef: 'slack-app',
  steps: () => notBuilt('the slack app guide'),
};

// the official slack server with the native parts of the app: the dm poll (src/integrations/slack-dms.ts) needs the
// two poll tools in the allow list. a send stays external, so each message waits for the owner, and the tools that
// schedule, draft or write canvases stay off.
export const SLACK: McpPreset = {
  connectorId: 'slack',
  integrationId: 'slack',
  name: 'Slack',
  icon: 'slack',
  summary: 'Search and read your messages, and check your direct messages every 15 minutes. Each message it sends asks you first.',
  docsUrl: 'https://api.slack.com/apps',
  url: 'https://mcp.slack.com/mcp',
  client: { type: 'owner-app', guide: SLACK_APP },
  callback: 'paste',
  scopes: SLACK_SCOPES,
  readTools: [...SLACK_POLL_TOOLS, 'slack_read_channel', 'slack_read_thread'],
  writeTools: ['slack_send_message'],
  blockedTools: ['slack_schedule_message', 'slack_send_message_draft', 'slack_create_canvas', 'slack_update_canvas'],
  poll: 'slack-dms',
};
