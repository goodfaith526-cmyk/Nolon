import { defineConfig } from 'vitest/config';

// Integration tests: need a migrated PostgreSQL at DATABASE_URL. Files: test/**/*.int-spec.ts
export default defineConfig({
  test: {
    include: ['test/**/*.int-spec.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
