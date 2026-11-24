/**
 * 运行配置：读取项目根目录（运行时的工作目录）下的 .env，真实环境变量优先。
 * 时区固定北京时间：所有「哪一天」「考核时段」都按东八区切，不依赖电脑的时区设置。
 */
import fs from 'fs'
import path from 'path'

process.env.TZ = 'Asia/Shanghai'

export const ROOT = process.cwd()

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

loadDotEnv(path.join(ROOT, '.env'))

const env = (key: string, fallback = ''): string => (process.env[key] ?? '').trim() || fallback

export const config = {
  port: Number(env('PORT', '8092')),
  mysql: {
    host: env('MYSQL_HOST', '127.0.0.1'),
    port: Number(env('MYSQL_PORT', '3307')),
    user: env('MYSQL_USER', 'kefu_platform'),
    password: env('MYSQL_PASSWORD'),
    database: env('MYSQL_DATABASE', 'kefu_platform')
  },
  /** 网页打包产物目录（vite build 输出） */
  webDir: path.join(ROOT, 'dist', 'web'),
  /** 本地数据目录（初始账号密码等，不提交 git） */
  dataDir: path.join(ROOT, 'data')
}
