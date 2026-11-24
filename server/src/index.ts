/**
 * 客服考核数据平台 · 服务端入口
 * 一个进程同时提供接口（/api/*）和网页（dist/web）。端口默认 8092。
 */
import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { config } from './config'
import { ensureSchema, pool } from './db'
import { seed } from './seed'
import { authHook, HttpError } from './auth'
import { authRoutes } from './routes/auth'

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: 'info' }, trustProxy: false, bodyLimit: 10 * 1024 * 1024 })

  await ensureSchema()
  await seed()

  await app.register(cookie)
  app.addHook('preHandler', authHook)

  // 统一错误格式：{ success:false, error }
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ success: false, error: err.message })
      return
    }
    req.log.error({ err }, '接口异常')
    reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ success: false, error: err.message || '服务端错误' })
  })

  app.get('/api/health', async () => ({ success: true, data: { ok: true, time: Math.floor(Date.now() / 1000) } }))
  await app.register(authRoutes)

  // 网页：dist/web 下的静态文件；非 /api 的未知路径都回 index.html（前端路由）
  const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'))
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDir, prefix: '/', wildcard: false })
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb) {
      reply.code(404).send({ success: false, error: '接口不存在' })
      return
    }
    reply.type('text/html').sendFile('index.html')
  })

  const close = async (): Promise<void> => {
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)

  await app.listen({ host: '0.0.0.0', port: config.port })
  app.log.info(`客服考核数据平台已启动：http://127.0.0.1:${config.port}${hasWeb ? '' : '（未找到网页打包产物，只提供接口）'}`)
}

main().catch((err) => {
  console.error('启动失败：', err)
  process.exit(1)
})
