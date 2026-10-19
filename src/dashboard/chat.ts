import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// phase 5 m2 owns this module. it mounts POST /api/chat, POST /api/chat/button, POST /api/chat/stop and
// GET /api/chat/stream. docs/PHASE5-API.md gives the shapes and the errors. server.ts calls it after the sign-in
// check, so each route is behind the dashboard auth.
// the chat stream sends event: ping this often, so a proxy or the browser does not close a quiet stream.
export const CHAT_PING_MS = 25_000;

export function mountChat(_server: Hono, _deps: DashboardDeps): void {}
