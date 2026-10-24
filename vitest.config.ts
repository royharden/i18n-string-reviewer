import { defineConfig } from 'vitest/config';

// Core tests run in Node (Intl, TextDecoder and crypto.subtle are globals there).
// UI tests opt into jsdom per file with `// @vitest-environment jsdom`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    restoreMocks: true,
  },
});
