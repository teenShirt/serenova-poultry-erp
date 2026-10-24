// Bundles the Node server (src/server) into dist/server/index.js. npm packages stay external.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  tsconfig: 'tsconfig.node.json',
  logLevel: 'info'
})
