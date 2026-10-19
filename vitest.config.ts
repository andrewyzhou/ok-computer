import { defineConfig } from 'vitest/config';

// the tests seed days and times in the owner's zone, and a config with the default time zone takes the zone of the
// system. a ci runner is in utc, where the seeded evening is already the next day. so every run uses one zone.
process.env.TZ = 'America/Los_Angeles';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'web/src/**/*.test.tsx'],
    globalSetup: ['test/temp-root.ts'],
    env: { TZ: 'America/Los_Angeles' },
  },
});
