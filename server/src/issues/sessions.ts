/**
 * 会话记录里的对公群 = AI 整理出的群问题：一个问题一行（source = 'wg'，渠道 -2），挂在处理人名下。
 * - 处理人按主管改过的算；只挂本部门成员处理的问题（商务等处理的、没人处理的只在「群问题」里看）
 * - 按规则切的群会话（source = 'wgr'）只在后台给技术支持部第二项计分，不在会话记录里出现；核对准确率达标、计分改成按 AI 后去掉
 * 群问题有变化（分析完、主管改了处理人 / 状态、员工挂靠变了）就对一遍；内容指纹没变的不动。
 */
import { createHash } from 'crypto'
import { execute, now, query } from '../db'
import { listDepartments, type Department } from '../auth'
import { deptProjectId } from '../members'

const WG_CHANNEL = -2
const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T))
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 会话 ID：部门 + 群 + 问题第一条消息（重新分析后问题编号会变，第一条消息不变就还是这一行） */
export const issueSessionId = (deptId: number, roomId: string, anchor: string): string => `wgi_${deptId}_${sha(`${roomId}|${anchor}`).slice(0, 40)}`

interface Row {
  id: number; room_id: string; room_name: string; anchor_msg_id: string; summary: string; message_ids: unknown
  handler_user_id: string; status: string; first_customer_at: number; override_handler: string | null; override_status: string | null
}

async function refresh(dept: Department): Promise<{ upserted: number; removed: number }> {
  const projectId = await deptProjectId(dept)
  if (!dept.groupChat || !projectId) return { upserted: 0, removed: 0 }
  const issues = await query<Row>(
    `SELECT i.id, i.room_id, i.room_name, i.anchor_msg_id, i.summary, i.message_ids, i.handler_user_id, i.status, i.first_customer_at,
            k.override_handler, k.override_status
     FROM wg_issues i
     LEFT JOIN wg_issue_marks k ON k.department_id = i.department_id AND k.room_id = i.room_id AND k.anchor_msg_id = i.anchor_msg_id
     WHERE i.department_id = ?`,
    [dept.id]
  )
  // 员工（企微）→ 本部门成员
  const staff = await query<{ user_id: string; sys_user_id: number }>(
    `SELECT w.user_id, w.sys_user_id FROM wg_staff w
     JOIN members m ON m.project_id = ? AND m.sys_user_id = w.sys_user_id AND m.department_id = ?
     WHERE w.sys_user_id > 0`,
    [projectId, dept.id]
  )
  const memberOf = new Map(staff.map((s) => [s.user_id, Number(s.sys_user_id)]))

  const want = new Map<string, { r: Row; sysUserId: number; status: string; msgIds: string[]; sig: string }>()
  for (const r of issues) {
    const handler = r.override_handler !== null && r.override_handler !== undefined ? r.override_handler : r.handler_user_id
    const sysUserId = handler ? memberOf.get(handler) || 0 : 0
    if (!sysUserId) continue
    const status = r.override_status || r.status
    const msgIds = json<string[]>(r.message_ids, [])
    const sig = sha(JSON.stringify([r.id, sysUserId, status, r.summary, r.room_name, msgIds, Number(r.first_customer_at)]))
    want.set(issueSessionId(dept.id, r.room_id, r.anchor_msg_id), { r, sysUserId, status, msgIds, sig })
  }

  const have = await query<{ session_id: string; content_sig: string }>(
    "SELECT session_id, content_sig FROM ss_sessions WHERE project_id = ? AND source = 'wg' AND session_id LIKE ?",
    [projectId, `wgi\\_${dept.id}\\_%`]
  )
  const haveSig = new Map(have.map((h) => [h.session_id, h.content_sig]))
  const stale = have.map((h) => h.session_id).filter((id) => !want.has(id))
  for (let i = 0; i < stale.length; i += 500) {
    const ids = stale.slice(i, i + 500)
    await execute('DELETE FROM ai_scores WHERE project_id = ? AND session_id IN (?)', [projectId, ids])
    await execute('DELETE FROM ss_sessions WHERE project_id = ? AND session_id IN (?)', [projectId, ids])
  }

  const changed = [...want.entries()].filter(([id, w]) => haveSig.get(id) !== w.sig)
  if (changed.length) {
    // 消息条数、起止时间从原始群消息算
    const allIds = [...new Set(changed.flatMap(([, w]) => w.msgIds))]
    const info = new Map<string, { staff: boolean; self: boolean; at: number }>()
    for (let i = 0; i < allIds.length; i += 1000) {
      const rows = await query<{ msg_id: string; is_staff: number; is_self: number; send_time: number }>(
        'SELECT msg_id, is_staff, is_self, send_time FROM wg_messages WHERE msg_id IN (?)', [allIds.slice(i, i + 1000)]
      )
      for (const m of rows) info.set(m.msg_id, { staff: !!m.is_staff, self: !!m.is_self, at: Number(m.send_time) })
    }
    const t = now()
    const values = changed.map(([id, w]) => {
      const ms = w.msgIds.map((x) => info.get(x)).filter((x): x is { staff: boolean; self: boolean; at: number } => !!x)
      const times = ms.map((m) => m.at)
      const first = Number(w.r.first_customer_at) || 0
      const start = times.length ? Math.min(...times) : first
      const end = times.length ? Math.max(...times) : first
      return [projectId, id, 'wg', w.r.room_id.slice(0, 128), w.sig, w.r.id, w.status, (w.r.summary || '').slice(0, 255), '',
        (w.r.room_name || w.r.room_id).slice(0, 255), w.sysUserId, WG_CHANNEL, 0, start, end, first || start, 0, 0, '',
        ms.length, ms.filter((m) => !m.staff && !m.self).length, ms.filter((m) => m.staff && !m.self).length, 1, 0, t]
    })
    for (let i = 0; i < values.length; i += 300) {
      await execute(
        `INSERT INTO ss_sessions (project_id, session_id, source, room_id, content_sig, issue_id, issue_status, issue_summary, chat_user_id,
           customer_name, sys_user_id, channel, channel_id, start_time, end_time, assign_time, star_score, quality_score, tags,
           msg_count, user_msg_count, kf_msg_count, msgs_synced, msg_fail, synced_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE content_sig = VALUES(content_sig), issue_id = VALUES(issue_id), issue_status = VALUES(issue_status),
           issue_summary = VALUES(issue_summary), customer_name = VALUES(customer_name), sys_user_id = VALUES(sys_user_id),
           start_time = VALUES(start_time), end_time = VALUES(end_time), assign_time = VALUES(assign_time), msg_count = VALUES(msg_count),
           user_msg_count = VALUES(user_msg_count), kf_msg_count = VALUES(kf_msg_count), synced_at = VALUES(synced_at)`,
        [values.slice(i, i + 300)]
      )
    }
  }
  return { upserted: changed.length, removed: stale.length }
}

const chains = new Map<number, Promise<unknown>>()

/** 把一个部门的群问题对到会话记录里（同一部门排队跑，不并发） */
export function refreshIssueSessions(dept: Department): Promise<{ upserted: number; removed: number }> {
  const next = (chains.get(dept.id) || Promise.resolve()).catch(() => undefined).then(() => refresh(dept))
  chains.set(dept.id, next)
  void next.catch(() => undefined).finally(() => { if (chains.get(dept.id) === next) chains.delete(dept.id) })
  return next
}

/** 所有开了对公群的部门对一遍（启动时用） */
export async function refreshAllIssueSessions(): Promise<void> {
  for (const dept of await listDepartments()) {
    if (!dept.groupChat) continue
    try {
      const r = await refreshIssueSessions(dept)
      if (r.upserted || r.removed) console.log(`[issues] ${dept.name} 会话记录里的群问题：更新 ${r.upserted}，删掉 ${r.removed}`)
    } catch (err) {
      console.error(`[issues] ${dept.name} 群问题写进会话记录失败：${(err as Error).message}`)
    }
  }
}
