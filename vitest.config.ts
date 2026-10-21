import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Minimal Vitest config for the pure unit tests under `tests/unit`. These test
// Zod schemas and the server-network command/response helpers, which import via
// the Nuxt aliases `#shared/...` and `~~/...`. Plain Vitest does not know those
// aliases, so map them here. Node environment is enough (no DOM needed).
export default defineConfig({
  resolve: {
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // Project-wide fast-check floor (see the setup file); harmless for the
    // example-based tests here and future property tests inherit it.
    setupFiles: ['tests/setup/fast-check.setup.ts'],
  },
})
