import { defineConfig } from 'vitest/config';

// Unit tests: no database, no network. Files: src/**/*.spec.ts
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
