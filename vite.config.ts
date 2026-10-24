import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = import.meta.dirname

/** The browser app. In development, API calls are proxied to the Node server (npm run dev:server). */
export default defineConfig({
  root: resolve(root, 'src/client'),
  publicDir: resolve(root, 'resources/public'),
  resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@renderer': resolve(root, 'src/client/src') } },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${process.env['PORT'] ?? 3000}`,
      '/manuals': `http://localhost:${process.env['PORT'] ?? 3000}`
    }
  },
  build: { outDir: resolve(root, 'dist/client'), emptyOutDir: true }
})
