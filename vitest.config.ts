import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'node:path'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, './src/lib'),
    },
    // trong test dùng bản browser của svelte thay vì SSR
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    globals: true,
    passWithNoTests: true,
  },
})
