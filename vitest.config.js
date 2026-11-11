import { defineConfig } from 'vitest/config';

// Tests in tests/ build their own jsdom window per case (tests/loader.test.js), so Vitest itself runs in Node.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
