import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Pin an inline (empty) PostCSS config so Vite does NOT walk up the directory
  // tree looking for a postcss.config.js. Without this, a stray
  // postcss.config.js in a parent folder (e.g. C:\\Users\\PC\\Downloads) can
  // hijack the test run on Windows. (Same guard as the MCP server suite.)
  css: { postcss: {} },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
});
