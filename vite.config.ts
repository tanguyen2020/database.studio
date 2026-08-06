import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { createRequire } from 'node:module'

// Single source of truth for the version shown in Settings → Updates. Reading
// package.json here keeps it in step with tauri.conf.json (both bumped together).
const { version } = createRequire(import.meta.url)('./package.json') as { version: string }

// Tauri dev server: fixed port, no auto-clear, ignore src-tauri/ changes
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, './src/lib'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/spec/**', '**/test-results/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    target: 'es2022',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
