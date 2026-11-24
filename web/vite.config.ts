import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时网页跑在 5173，/api 转发到服务端 8092；打包产物输出到 dist/web，由服务端直接提供
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  build: { outDir: resolve(__dirname, '../dist/web'), emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8092' } },
  optimizeDeps: { include: ['react', 'react-dom', 'react/jsx-runtime', '@douyinfe/semi-ui', '@douyinfe/semi-icons'] }
})
