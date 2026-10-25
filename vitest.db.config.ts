import { defineConfig } from 'vitest/config';

/** Integration tests against a real Postgres (DATABASE_URL, default postgres://postgres@localhost:5432/postgres). */
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.db.test.ts'],
    globalSetup: ['packages/db/tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
