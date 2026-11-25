/**
 * 成员接口。
 * - 主管：只看、只改自己部门的成员（班次、参与考核），可以从 SaleSmartly 重新拉取
 * - 总管理员：能看这个项目的全部成员，还能把人分到别的部门
 */
import type { FastifyInstance } from 'fastify'
import { audit, HttpError, listDepartments, resolveDepartment } from '../auth'
import { query, execute, now } from '../db'
import { deptProjectId, pullMembers, SHIFT_KEYS, SHIFT_LABELS, toView, type MemberRow, type ShiftKey } from '../members'
import { describeFetchError } from '../services/salesmartly'

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  /** 成员列表。管理员带 scope=all 时返回整个项目（含别的部门、未分配的人） */
  app.get('/api/members', async (req) => {
    const q = req.query as { dept?: string; scope?: string }
    const dept = await resolveDepartment(req, q.dept)
    const projectId = await deptProjectId(dept)
    if (!projectId) return { success: true, data: { projectId: '', list: [], lastPulledAt: 0 } }

    const all = req.user!.role === 'admin' && q.scope === 'all'
    const rows = await query<MemberRow>(
      `SELECT * FROM members WHERE project_id = ? ${all ? '' : 'AND department_id = ?'}
       ORDER BY active DESC, nickname`,
      all ? [projectId] : [projectId, dept.id]
    )
    const [last] = await query<{ t: number | null }>('SELECT MAX(last_seen_at) t FROM members WHERE project_id = ?', [projectId])
    const depts = await listDepartments()
    return { success: true, data: { projectId, list: rows.map((r) => toView(r, depts)), lastPulledAt: Number(last?.t || 0) } }
  })

  /** 从 SaleSmartly 重新拉一次成员 */
  app.post('/api/members/pull', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    let r
    try {
      r = await pullMembers(dept)
    } catch (err) {
      throw new HttpError(400, describeFetchError(err))
    }
    await audit(req, 'members_pull', dept.code, r, dept.id)
    return { success: true, data: r }
  })

  /** 改一个成员：班次、参与考核；总管理员还能改部门 */
  app.put('/api/members/:id', async (req) => {
    const user = req.user!
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const id = Number((req.params as { id: string }).id)
    const [m] = await query<MemberRow>('SELECT * FROM members WHERE id = ?', [id])
    if (!m) throw new HttpError(404, '成员不存在')
    // 主管只能改自己部门的人；管理员只能改当前部门项目里的人
    if (m.project_id !== (await deptProjectId(dept))) throw new HttpError(403, '不是本部门 SaleSmartly 项目里的成员')
    if (user.role !== 'admin' && m.department_id !== dept.id) throw new HttpError(403, '只能改本部门的成员')

    const body = (req.body || {}) as { shift?: string | null; participate?: boolean; departmentCode?: string | null }
    const sets: string[] = []
    const params: unknown[] = []
    const changed: Record<string, unknown> = {}

    if ('shift' in body) {
      const shift = body.shift === null || body.shift === '' ? null : String(body.shift)
      if (shift !== null && !SHIFT_KEYS.includes(shift as ShiftKey)) throw new HttpError(400, '班次不对')
      sets.push('shift = ?')
      params.push(shift)
      changed.shift = shift ? SHIFT_LABELS[shift as ShiftKey] : '自动'
    }
    if ('participate' in body) {
      sets.push('participate = ?')
      params.push(body.participate ? 1 : 0)
      changed.participate = !!body.participate
    }
    if ('departmentCode' in body) {
      if (user.role !== 'admin') throw new HttpError(403, '只有总管理员能把成员分到别的部门')
      let deptId: number | null = null
      if (body.departmentCode) {
        const target = (await listDepartments()).find((d) => d.code === body.departmentCode)
        if (!target) throw new HttpError(400, '部门不存在')
        deptId = target.id
      }
      sets.push('department_id = ?')
      params.push(deptId)
      changed.department = body.departmentCode || '未分配'
    }
    if (!sets.length) throw new HttpError(400, '没有要改的内容')

    await execute(`UPDATE members SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`, [...params, now(), user.username, id])
    await audit(req, 'member_update', `${m.nickname}(${m.sys_user_id})`, changed, dept.id)
    const [row] = await query<MemberRow>('SELECT * FROM members WHERE id = ?', [id])
    return { success: true, data: toView(row, await listDepartments()) }
  })
}
