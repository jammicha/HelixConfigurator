import { defineConfig } from 'vitest/config';

// Standalone test config (kept separate from vite.config.ts so the dev-server
// proxy/react-plugin setup doesn't load during tests). The util suite under
// test is pure functions, so the default node environment is all we need.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
