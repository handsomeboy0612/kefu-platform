/**
 * 登录与权限。
 * - 会话：随机 token 放在 httpOnly Cookie，数据库只存 token 的 SHA-256；有效期 7 天
 * - 角色：admin 看全部部门；manager 只看自己部门
 * - 首次登录（must_change_password）只能调用 /api/auth/*，改完密码才能用其他接口
 * - 同一用户名连续输错 5 次锁 10 分钟
 */
import crypto from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { execute, now, query } from './db'

export const SESSION_COOKIE = 'kp_session'
const SESSION_TTL = 7 * 86400

export interface AuthUser {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'manager'
  departmentId: number | null
  mustChangePassword: boolean
}

export interface Department {
  id: number
  code: string
  name: string
  kpiTemplate: 'cs' | 'tech'
  groupChat: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

/** 接口统一的业务错误：带 HTTP 状态码，由全局错误处理转成 { success:false, error } */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

export async function createSession(accountId: number, ip: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex')
  await execute(
    'INSERT INTO auth_sessions (token_hash, account_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)',
    [sha256(token), accountId, now(), now() + SESSION_TTL, ip]
  )
  // 顺带清掉过期会话
  await execute('DELETE FROM auth_sessions WHERE expires_at < ?', [now()])
  return token
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await execute('DELETE FROM auth_sessions WHERE token_hash = ?', [sha256(token)])
}

export async function destroyAccountSessions(accountId: number, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await execute('DELETE FROM auth_sessions WHERE account_id = ? AND token_hash <> ?', [accountId, sha256(exceptToken)])
  } else {
    await execute('DELETE FROM auth_sessions WHERE account_id = ?', [accountId])
  }
}

async function userFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null
  const rows = await query<{
    id: number; username: string; display_name: string; role: string
    department_id: number | null; must_change_password: number; disabled: number
  }>(
    `SELECT a.id, a.username, a.display_name, a.role, a.department_id, a.must_change_password, a.disabled
     FROM auth_sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), now()]
  )
  const r = rows[0]
  if (!r || r.disabled) return null
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role === 'admin' ? 'admin' : 'manager',
    departmentId: r.department_id,
    mustChangePassword: !!r.must_change_password
  }
}

/** 全局钩子：解析登录态。/api/* 中除了登录、健康检查外都要求已登录 */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = req.url.split('?')[0]
  if (!url.startsWith('/api/')) return
  if (url === '/api/health' || url === '/api/auth/login') return
  const user = await userFromToken(req.cookies[SESSION_COOKIE])
  if (!user) {
    reply.code(401).send({ success: false, error: '未登录或登录已过期' })
    return reply
  }
  if (user.mustChangePassword && !url.startsWith('/api/auth/')) {
    reply.code(403).send({ success: false, error: '首次登录请先修改密码' })
    return reply
  }
  req.user = user
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  if (req.user?.role !== 'admin') throw new HttpError(403, '只有总管理员可以操作')
  return req.user
}

export async function listDepartments(): Promise<Department[]> {
  const rows = await query<{ id: number; code: string; name: string; kpi_template: string; group_chat: number }>(
    'SELECT id, code, name, kpi_template, group_chat FROM departments ORDER BY sort, id'
  )
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    kpiTemplate: r.kpi_template === 'tech' ? 'tech' : 'cs',
    groupChat: !!r.group_chat
  }))
}

/** 当前账号能看的部门：管理员全部，主管只有自己部门 */
export async function visibleDepartments(user: AuthUser): Promise<Department[]> {
  const all = await listDepartments()
  return user.role === 'admin' ? all : all.filter((d) => d.id === user.departmentId)
}

/**
 * 解析本次请求操作的部门（请求参数 dept = 部门 code）。
 * 主管只能操作自己部门，传别的部门直接 403；管理员不传时报错，避免误操作到错误部门。
 */
export async function resolveDepartment(req: FastifyRequest, deptCode: unknown): Promise<Department> {
  const user = req.user!
  const visible = await visibleDepartments(user)
  if (user.role !== 'admin') {
    const own = visible[0]
    if (!own) throw new HttpError(403, '账号没有绑定部门')
    if (deptCode && deptCode !== own.code) throw new HttpError(403, '只能查看自己部门的数据')
    return own
  }
  const d = visible.find((x) => x.code === deptCode)
  if (!d) throw new HttpError(400, '请选择部门')
  return d
}

export function clientIp(req: FastifyRequest): string {
  return (req.ip || '').replace(/^::ffff:/, '')
}

/** 记操作日志（失败不影响业务） */
export async function audit(
  req: FastifyRequest,
  action: string,
  target = '',
  detail: unknown = null,
  departmentId: number | null = null,
  actor?: { id: number; username: string }
): Promise<void> {
  const who = actor || req.user
  try {
    await execute(
      `INSERT INTO audit_logs (account_id, username, department_id, action, target, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [who?.id ?? null, who?.username ?? '', departmentId, action, target,
        detail == null ? null : JSON.stringify(detail), clientIp(req), now()]
    )
  } catch (err) {
    req.log.error({ err }, '写操作日志失败')
  }
}

// ── 登录失败限流（进程内）───────────────────────────────────
const failures = new Map<string, { count: number; until: number }>()
const MAX_FAILURES = 5
const LOCK_SEC = 600

export function checkLocked(username: string): void {
  const f = failures.get(username)
  if (f && f.until > now()) {
    throw new HttpError(429, `密码错误次数过多，请 ${Math.ceil((f.until - now()) / 60)} 分钟后再试`)
  }
}

export function recordFailure(username: string): void {
  const f = failures.get(username) || { count: 0, until: 0 }
  if (f.until && f.until <= now()) f.count = 0
  f.count++
  if (f.count >= MAX_FAILURES) f.until = now() + LOCK_SEC
  failures.set(username, f)
}

export function clearFailures(username: string): void {
  failures.delete(username)
}
