import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: ['**/*.db.test.ts', '**/node_modules/**'],
  },
});
