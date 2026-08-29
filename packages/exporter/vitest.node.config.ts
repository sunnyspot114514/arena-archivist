import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  test: {
    environment: 'node',
    include: [
      'apps/runtime/tests/**/*.test.ts',
      'packages/auth-broker/tests/**/*.test.ts',
      'packages/model-router/tests/**/*.test.ts',
      'packages/analysis-engine/tests/**/*.test.ts',
      'packages/exporter/tests/**/*.test.ts',
      'lib/**/*.test.ts',
    ],
  },
});
