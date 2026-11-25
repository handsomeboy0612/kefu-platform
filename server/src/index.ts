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
import { migrateLegacySettings } from './settings'
import { authHook, HttpError } from './auth'
import { authRoutes } from './routes/auth'
import { settingsRoutes } from './routes/settings'
import { accountRoutes } from './routes/accounts'
import { memberRoutes } from './routes/members'
import { sessionRoutes } from './routes/sessions'
import { syncRoutes } from './routes/sync'
import { scoreRoutes } from './routes/scores'
import { kpiRoutes } from './routes/kpi'
import { dashboardRoutes } from './routes/dashboard'
import { groupRoutes } from './routes/group'
import { startGroupScheduler } from './group/sync'
import { startNightlyScheduler } from './ai/service'
import { startScheduler } from './sync/salesmartly-sync'

async function main(): Promise<void> {
  // LOG_LEVEL：正式部署用 warn（不记每个请求），开发默认 info
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: false, bodyLimit: 10 * 1024 * 1024 })

  await ensureSchema()
  await seed()
  await migrateLegacySettings()

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
  await app.register(settingsRoutes)
  await app.register(accountRoutes)
  await app.register(memberRoutes)
  await app.register(sessionRoutes)
  await app.register(syncRoutes)
  await app.register(scoreRoutes)
  await app.register(kpiRoutes)
  await app.register(dashboardRoutes)
  await app.register(groupRoutes)

  // 网页：dist/web 下的静态文件；非 /api 的未知路径都回 index.html（前端路由）
  const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'))
  if (hasWeb) {
    // wildcard：每次请求都去磁盘找文件，重新打包网页后不用重启服务；找不到的路径交给下面的 notFound（回 index.html）
    await app.register(fastifyStatic, { root: config.webDir, prefix: '/', wildcard: true, index: false })
    // 根路径是目录，index:false 时静态插件会回 403，这里直接给首页
    app.get('/', (_req, reply) => reply.type('text/html').sendFile('index.html'))
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb) {
      reply.code(404).send({ success: false, error: '接口不存在' })
      return
    }
    // 带扩展名的（js / css / 图片）是文件请求，找不到就是 404，不能回网页
    if (/\.[a-z0-9]+$/i.test(req.url.split('?')[0])) {
      reply.code(404).type('text/plain').send('Not Found')
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
  // 定时同步 SaleSmartly：1 分钟后第一轮，之后每小时
  await startScheduler()
  // 每晚 01:00 自动评前一天的会话（部门在「设置 → AI 质检」里打开才会评）
  startNightlyScheduler()
  // 对公群每小时同步（启动 3 分钟后第一轮）
  startGroupScheduler()
  // 用 console.log：正式部署时日志级别是 warn，启动信息也要能在 logs\server.log 里看到
  console.log(`${new Date().toLocaleString('zh-CN')} 客服考核数据平台已启动：http://127.0.0.1:${config.port}${hasWeb ? '' : '（未找到网页打包产物，只提供接口）'}`)
}

main().catch((err) => {
  console.error('启动失败：', err)
  process.exit(1)
})
