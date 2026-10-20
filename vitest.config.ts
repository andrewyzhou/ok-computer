import { defineConfig } from 'vitest/config';

// the tests seed days and times in the owner's zone, and a config with the default time zone takes the zone of the
// system. a ci runner is in utc, where the seeded evening is already the next day. so every run uses one zone.
process.env.TZ = 'America/Los_Angeles';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'web/src/**/*.test.tsx'],
    globalSetup: ['test/temp-root.ts'],
    env: { TZ: 'America/Los_Angeles' },
    // a limit catches a test that hangs. a shared ci runner, windows most of all, can take more than 5 s for the first
    // test of a file that seeds a whole app, so ci gets more time. a run on the owner's machine keeps the short limit.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
});
