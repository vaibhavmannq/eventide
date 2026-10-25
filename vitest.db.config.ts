import { defineConfig } from 'vitest/config';

/** Integration tests against a real Postgres (DATABASE_URL, default postgres://postgres@localhost:5432/postgres). */
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.db.test.ts'],
    globalSetup: ['packages/db/tests/global-setup.ts'],
    // One file at a time: each opens up to 25 connections, and Postgres allows 100 by default.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
