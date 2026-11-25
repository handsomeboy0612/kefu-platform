/**
 * 账号管理（只有总管理员能用）：列表、新建主管账号、重置密码、停用 / 启用。
 * 新建和重置都会生成随机密码，只在这次响应里返回一次，对方首次登录必须改掉。
 */
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { audit, destroyAccountSessions, HttpError, listDepartments, requireAdmin } from '../auth'
import { execute, now, query } from '../db'
import { randomPassword } from '../seed'

interface AccountRow {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'manager'
  department_id: number | null
  must_change_password: number
  disabled: number
  created_at: number
  last_login_at: number
}

async function getAccount(id: number): Promise<AccountRow> {
  const [row] = await query<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id])
  if (!row) throw new HttpError(404, '账号不存在')
  return row
}

const parseId = (p: unknown): number => {
  const id = Number((p as { id?: string }).id)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '账号 ID 不对')
  return id
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts', async (req) => {
    requireAdmin(req)
    const depts = await listDepartments()
    const rows = await query<AccountRow>("SELECT * FROM accounts ORDER BY role = 'admin' DESC, department_id, id")
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        departmentCode: depts.find((d) => d.id === r.department_id)?.code ?? null,
        departmentName: depts.find((d) => d.id === r.department_id)?.name ?? '',
        mustChangePassword: !!r.must_change_password,
        disabled: !!r.disabled,
        createdAt: Number(r.created_at),
        lastLoginAt: Number(r.last_login_at)
      }))
    }
  })

  /** 新建主管账号（总管理员只有一个，不在这里建） */
  app.post('/api/accounts', async (req) => {
    requireAdmin(req)
    const body = (req.body || {}) as { username?: string; displayName?: string; departmentCode?: string }
    const username = String(body.username || '').trim()
    const displayName = String(body.displayName || '').trim()
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '用户名 3-32 位，只能用字母、数字、下划线、点、横线')
    if (!displayName) throw new HttpError(400, '请填写姓名')
    const dept = (await listDepartments()).find((d) => d.code === body.departmentCode)
    if (!dept) throw new HttpError(400, '请选择部门')
    const [dup] = await query('SELECT id FROM accounts WHERE username = ?', [username])
    if (dup) throw new HttpError(400, '这个用户名已经有了')

    const password = randomPassword()
    const res = await execute(
      `INSERT INTO accounts (username, display_name, role, department_id, password_hash, must_change_password, created_at)
       VALUES (?, ?, 'manager', ?, ?, 1, ?)`,
      [username, displayName, dept.id, await bcrypt.hash(password, 10), now()]
    )
    await audit(req, 'account_create', username, { displayName, department: dept.code }, dept.id)
    return { success: true, data: { id: res.insertId, username, password } }
  })

  /** 重置密码：生成新的随机密码，对方所有登录失效，下次登录必须改密码 */
  app.post('/api/accounts/:id/reset-password', async (req) => {
    const admin = requireAdmin(req)
    const acc = await getAccount(parseId(req.params))
    if (acc.id === admin.id) throw new HttpError(400, '自己的密码请在「修改密码」里改')
    const password = randomPassword()
    await execute('UPDATE accounts SET password_hash = ?, must_change_password = 1 WHERE id = ?', [
      await bcrypt.hash(password, 10), acc.id
    ])
    await destroyAccountSessions(acc.id)
    await audit(req, 'account_reset_password', acc.username, null, acc.department_id)
    return { success: true, data: { username: acc.username, password } }
  })

  /** 停用 / 启用。停用后立刻踢下线，不能停用自己 */
  app.post('/api/accounts/:id/disabled', async (req) => {
    const admin = requireAdmin(req)
    const acc = await getAccount(parseId(req.params))
    const disabled = !!(req.body as { disabled?: boolean } | undefined)?.disabled
    if (acc.id === admin.id) throw new HttpError(400, '不能停用自己')
    await execute('UPDATE accounts SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, acc.id])
    if (disabled) await destroyAccountSessions(acc.id)
    await audit(req, disabled ? 'account_disable' : 'account_enable', acc.username, null, acc.department_id)
    return { success: true }
  })
}
