/**
 * 对公群接口（只有开了对公群的部门能用）：状态、群筛选和切段设置、群列表、员工挂靠、手动同步。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { audit, HttpError, resolveDepartment, type Department } from '../auth'
import { execute, now, query } from '../db'
import { getDeptSetting, isSectionConfigured } from '../settings'
import { deptProjectId } from '../members'
import { archiveGet, fetchGroupMembers, fetchGroups, type ArchiveHealth } from '../services/archive'
import { describeFetchError } from '../services/salesmartly'
import { getGroupConfig, saveGroupConfig, type GroupConfig } from '../group/config'
import { GroupBusyError, groupProgress, startGroupSync } from '../group/sync'
import { refreshIssueSessions } from '../issues/sessions'

const AGENT_OFFLINE_SEC = 30 * 60

async function groupDept(req: FastifyRequest): Promise<Department> {
  const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
  if (!dept.groupChat) throw new HttpError(404, '本部门没有对公群')
  return dept
}

const runKey = async (dept: Department): Promise<string> => `${await deptProjectId(dept)}:${dept.code}`

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  /** 状态：归档服务和采集端、同步进度、最近几次同步（含挂靠提醒、采集中断） */
  app.get('/api/group/status', async (req) => {
    const dept = await groupDept(req)
    const cfg = await getDeptSetting(dept.code, 'archive')
    let archive: Record<string, unknown> = { configured: isSectionConfigured('archive', cfg) }
    if (archive.configured) {
      try {
        const h = await archiveGet<ArchiveHealth>(cfg, '/health')
        archive = {
          ...archive, ok: true, msgTotal: h.msg_total, groups: h.groups,
          agents: (h.agents || []).map((a) => ({ name: a.agent_name, lastUploadAt: a.last_upload_at, online: h.server_time - (a.last_upload_at || 0) <= AGENT_OFFLINE_SEC }))
        }
      } catch (err) {
        archive = { ...archive, ok: false, error: describeFetchError(err) }
      }
    }
    const runs = await query<{ id: number; trigger: string; triggered_by: string; range_begin: number; range_end: number; status: string; started_at: number; finished_at: number; error: string | null; detail: unknown }>(
      "SELECT id, `trigger`, triggered_by, range_begin, range_end, status, started_at, finished_at, error, detail FROM sync_runs WHERE project_id = ? AND source = 'wg' ORDER BY id DESC LIMIT 10",
      [await runKey(dept)]
    )
    const projectId = await deptProjectId(dept)
    const [cnt] = await query<{ n: number; last: number | null }>(
      "SELECT COUNT(*) n, MAX(end_time) last FROM ss_sessions WHERE project_id = ? AND source = 'wg'", [projectId]
    )
    return {
      success: true,
      data: {
        archive,
        config: await getGroupConfig(dept),
        progress: groupProgress(dept.code),
        sessionTotal: Number(cnt?.n || 0),
        lastMessageAt: Number(cnt?.last || 0),
        runs: runs.map((r) => ({
          id: r.id, trigger: r.trigger, triggeredBy: r.triggered_by, rangeBegin: Number(r.range_begin), rangeEnd: Number(r.range_end),
          status: r.status, startedAt: Number(r.started_at), finishedAt: Number(r.finished_at), error: r.error,
          detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail
        }))
      }
    }
  })

  app.put('/api/group/config', async (req) => {
    const dept = await groupDept(req)
    const b = (req.body || {}) as Partial<GroupConfig>
    const gapMin = Math.round(Number(b.gapMin))
    if (!(gapMin >= 5 && gapMin <= 240)) throw new HttpError(400, '群聊停多久开始整理，要在 5~240 分钟之间')
    const c: GroupConfig = {
      roomFilterMode: b.roomFilterMode === 'manual' ? 'manual' : 'keyword',
      roomKeyword: String(b.roomKeyword || '').trim().slice(0, 50),
      selectedRooms: Array.isArray(b.selectedRooms) ? b.selectedRooms.map(String).slice(0, 2000) : [],
      gapMin
    }
    if (c.roomFilterMode === 'manual' && !c.selectedRooms.length) throw new HttpError(400, '手动选群至少要选一个群')
    await saveGroupConfig(dept, c, req.user!.username)
    await audit(req, 'group_config', dept.code, { ...c, selectedRooms: c.selectedRooms.length }, dept.id)
    return { success: true, data: c }
  })

  /** 归档服务里的全部群（标出全是员工的内部群） */
  app.get('/api/group/rooms', async (req) => {
    const dept = await groupDept(req)
    const cfg = await getDeptSetting(dept.code, 'archive')
    let groups
    try {
      groups = await fetchGroups(cfg)
    } catch (err) {
      throw new HttpError(502, `拉群列表失败：${describeFetchError(err)}`)
    }
    const out = []
    for (const g of groups) {
      let internal = false
      try {
        const ms = await fetchGroupMembers(cfg, g.room_id)
        internal = ms.length > 0 && ms.every((m) => m.is_staff === 1)
      } catch { /* 拉不到成员按非内部群 */ }
      out.push({ roomId: g.room_id, roomName: g.room_name, memberCount: g.member_count, msgTotal: g.msg_total, lastMsgAt: g.last_msg_at, internal })
    }
    return { success: true, data: out }
  })

  /** 群内员工挂靠列表 + 可选的成员 */
  app.get('/api/group/staff', async (req) => {
    const dept = await groupDept(req)
    const projectId = await deptProjectId(dept)
    const staff = await query<{ user_id: string; nickname: string; raw_name: string; sys_user_id: number; manual: number; last_seen_at: number; updated_by: string }>(
      'SELECT * FROM wg_staff ORDER BY sys_user_id = 0 DESC, nickname'
    )
    const members = await query<{ sys_user_id: number; nickname: string; department_id: number | null; participate: number; active: number }>(
      'SELECT sys_user_id, nickname, department_id, participate, active FROM members WHERE project_id = ? ORDER BY department_id = ? DESC, nickname',
      [projectId, dept.id]
    )
    const byId = new Map(members.map((m) => [Number(m.sys_user_id), m]))
    return {
      success: true,
      data: {
        staff: staff.map((s) => {
          const m = byId.get(Number(s.sys_user_id))
          return {
            userId: s.user_id, nickname: s.nickname, rawName: s.raw_name, sysUserId: Number(s.sys_user_id), manual: !!s.manual,
            lastSeenAt: Number(s.last_seen_at), memberName: m?.nickname || '',
            counted: !!m && m.department_id === dept.id && !!m.participate && !!m.active
          }
        }),
        members: members.map((m) => ({ sysUserId: Number(m.sys_user_id), nickname: m.nickname, inDept: m.department_id === dept.id }))
      }
    }
  })

  /** 手动指定挂靠；sysUserId = null 表示取消手动、恢复自动匹配；0 表示「不是我们的人」 */
  app.put('/api/group/staff/:userId', async (req) => {
    const dept = await groupDept(req)
    const userId = (req.params as { userId: string }).userId
    const b = (req.body || {}) as { sysUserId?: number | null }
    const [row] = await query('SELECT user_id FROM wg_staff WHERE user_id = ?', [userId])
    if (!row) throw new HttpError(404, '没有这个员工')
    if (b.sysUserId === null || b.sysUserId === undefined) {
      await execute('UPDATE wg_staff SET manual = 0, sys_user_id = 0, updated_by = ?, updated_at = ? WHERE user_id = ?', [req.user!.username, now(), userId])
    } else {
      const id = Math.trunc(Number(b.sysUserId)) || 0
      if (id) {
        const [m] = await query('SELECT 1 FROM members WHERE project_id = ? AND sys_user_id = ?', [await deptProjectId(dept), id])
        if (!m) throw new HttpError(400, '成员不存在')
      }
      await execute('UPDATE wg_staff SET manual = 1, sys_user_id = ?, updated_by = ?, updated_at = ? WHERE user_id = ?', [id, req.user!.username, now(), userId])
    }
    await audit(req, 'group_staff_map', userId, b, dept.id)
    // 会话记录里的群问题按新的挂靠对一遍
    await refreshIssueSessions(dept).catch((e) => console.error('[issues] 群问题写进会话记录失败', e))
    return { success: true }
  })

  /** 手动同步一段时间（按群会话开头的时间），最长 62 天 */
  app.post('/api/group/sync', async (req) => {
    const dept = await groupDept(req)
    const b = (req.body || {}) as { begin?: number; end?: number }
    const begin = Math.trunc(Number(b.begin))
    const end = Math.trunc(Number(b.end))
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end) throw new HttpError(400, '请选择时间段')
    if (end - begin > 62 * 86400) throw new HttpError(400, '一次最多同步 62 天')
    try {
      const runId = await startGroupSync(dept, begin, end, 'manual', req.user!.username)
      await audit(req, 'group_sync', dept.code, { begin, end, runId }, dept.id)
      return { success: true, data: { runId } }
    } catch (err) {
      throw new HttpError(err instanceof GroupBusyError ? 409 : 400, (err as Error).message)
    }
  })
}
