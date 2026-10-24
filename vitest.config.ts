import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 120000,
    hookTimeout: 600000,
    // All test files share one MySQL server; each test uses its own database.
    fileParallelism: false
  }
})
