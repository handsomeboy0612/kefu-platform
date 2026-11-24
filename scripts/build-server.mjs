// 服务端打包：TypeScript → dist/server.cjs（依赖不打进来，运行时从 node_modules 加载）
import { build } from 'esbuild'

await build({
  entryPoints: ['server/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/server.cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info'
})
