import { vi } from 'vitest';
import path from 'node:path';

// Mock electron module
vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn((name) => {
        if (name === 'userData') {
          // Use a temporary directory for user data during tests
          // This helps keep tests isolated and avoids polluting the real user data directory
          // The 'test-userData' directory will be relative to the project root during test execution
          return path.resolve(__dirname, 'test-userData');
        }
        // Fallback for other paths if needed, though 'userData' is the primary concern
        return path.resolve(__dirname, `test-${name}`);
      }),
      // Mock other app properties or methods if needed by the code under test
      isPackaged: false,
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    // Mock other Electron modules like BrowserWindow, dialog, etc., if necessary
  };
});
