import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true, // To use vi, describe, it, etc., globally
    setupFiles: ['./vitest.setup.main.ts'], // For global mocks like electron
    include: ['src/main/**/*.test.ts'], // Specify test file pattern for main process
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'packages/shared'),
      // @types is usually for renderer, but if main process code imports types from there
      '@types': resolve(__dirname, 'src/renderer/src/types'), 
    },
  },
});
