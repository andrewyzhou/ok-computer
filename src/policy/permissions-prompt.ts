import type { Db } from '../db/index.js';
import { DOMAINS, type AutonomyLevel } from './autonomy.js';
import { levelOf } from './autonomy-store.js';

// the permissions part of the prompt: the level of each domain of the trust ladder in plain words, so the agent knows
// where the owner drew the line. the ladder in the caller enforces it; this text only tells the model. SOUL.md points
// here as "Permissions".
const LEVEL_WORDS: Record<AutonomyLevel, string> = {
  auto: 'do it, then tell them',
  review: 'do it, a second check looks first',
  ask: 'get it ready, they approve it',
};

export function permissionsInstructions(db: Db): string {
  const lines = DOMAINS.map((domain) => `- ${domain.label}: ${LEVEL_WORDS[levelOf(db, domain.id)]}`);
  return `Permissions: what you can do on your own. They chose these, and the app holds you to them.
${lines.join('\n')}
Anything else that sends, pays, or deletes waits for their OK. When something waits for their OK, get it fully ready first, so all they have to do is approve it.`;
}
