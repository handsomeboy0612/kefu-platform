/**
 * 登录相关接口：登录、退出、当前用户、修改密码。
 */
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import {
  audit, checkLocked, clearFailures, clientIp, createSession, destroyAccountSessions, destroySession,
  HttpError, recordFailure, SESSION_COOKIE, visibleDepartments
} from '../auth'
import { execute, now, query } from '../db'

const COOKIE_OPTS = { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 7 * 86400 }

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body || {}) as { username?: string; password?: string }
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    if (!username || !password) throw new HttpError(400, '请输入用户名和密码')
    checkLocked(username)

    const rows = await query<{ id: number; username: string; password_hash: string; disabled: number; department_id: number | null }>(
      'SELECT id, username, password_hash, disabled, department_id FROM accounts WHERE username = ?',
      [username]
    )
    const acc = rows[0]
    const ok = acc && !acc.disabled && (await bcrypt.compare(password, acc.password_hash))
    if (!ok) {
      recordFailure(username)
      await audit(req, 'login_failed', username)
      throw new HttpError(401, '用户名或密码错误')
    }
    clearFailures(username)
    const token = await createSession(acc.id, clientIp(req))
    await execute('UPDATE accounts SET last_login_at = ? WHERE id = ?', [now(), acc.id])
    await audit(req, 'login', username, null, acc.department_id, { id: acc.id, username: acc.username })
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS)
    return { success: true }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { success: true }
  })

  app.get('/api/auth/me', async (req) => {
    const user = req.user!
    return { success: true, data: { user, departments: await visibleDepartments(user) } }
  })

  app.post('/api/auth/change-password', async (req) => {
    const user = req.user!
    const body = (req.body || {}) as { oldPassword?: string; newPassword?: string }
    const oldPassword = String(body.oldPassword || '')
    const newPassword = String(body.newPassword || '')
    if (newPassword.length < 8) throw new HttpError(400, '新密码至少 8 位')
    if (newPassword === oldPassword) throw new HttpError(400, '新密码不能和原密码相同')
    const [acc] = await query<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE id = ?', [user.id])
    if (!acc || !(await bcrypt.compare(oldPassword, acc.password_hash))) throw new HttpError(400, '原密码不正确')
    await execute('UPDATE accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?', [
      await bcrypt.hash(newPassword, 10), user.id
    ])
    // 改密码后其他设备上的登录全部失效，当前这个保留
    await destroyAccountSessions(user.id, req.cookies[SESSION_COOKIE])
    await audit(req, 'change_password', user.username, null, user.departmentId)
    return { success: true }
  })
}
