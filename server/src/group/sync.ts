/**
 * 对公群同步：按时间段从群聊归档服务拉群消息 → 群筛选 → 存进 wg_messages（AI 整理群问题用）→ 员工挂靠 → 挂靠提醒。
 * 同步完把群问题对到会话记录里，再看有没有聊完的群要 AI 分析（issues/analyze.ts）。
 * 按时间切段拆群会话的旧方法（从桌面版搬来的）2026-11-26 弃用，对公群只按 AI 整理的群问题算。
 *
 * 员工 → 成员挂靠：群昵称去掉部门前缀后同名优先，再包含匹配（取最长）；分不清就不挂，列进提醒；手动指定的不覆盖。
 */
import { execute, now, query } from '../db'
import { listDepartments, type Department } from '../auth'
import { getDeptSetting, isSectionConfigured } from '../settings'
import { deptProjectId } from '../members'
import {
  fetchGaps, fetchGroupMembers, fetchGroups, fetchMessagesByRange, fetchStaff,
  type ArchiveGap, type ArchiveMessage
} from '../services/archive'
import { describeFetchError } from '../services/salesmartly'
import { getGroupConfig } from './config'
import { autoAnalyze } from '../issues/analyze'
import { refreshIssueSessions } from '../issues/sessions'

// 每 10 分钟同步最近 2 天（群消息在本机归档服务里，拉一次一秒左右），几乎等于实时
const AUTO_LOOKBACK_SEC = 2 * 86400
const AUTO_INTERVAL_MS = 10 * 60 * 1000

const normName = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase()
/** 去部门前缀：「技术支持部-张三」→「张三」（兼容全角 / 长横线） */
export function stripDept(s: string): string {
  const t = (s || '').trim()
  const i = Math.max(t.lastIndexOf('-'), t.lastIndexOf('－'), t.lastIndexOf('—'))
  return i >= 0 ? t.slice(i + 1).trim() : t
}
const TECH_NICK_RE = /技术支持|技术组|研发|开发/

type MatchResult = { sysUserId: number; how: 'exact' | 'contains'; name: string } | { sysUserId: 0; ambiguous: string[] } | { sysUserId: 0 }

/** 员工 → 成员自动匹配：先同名（去部门前缀），再包含（取最长名字；最长的不止一个就不挂）；少于 2 个字的名字不做包含匹配 */
export function matchMember(candidates: string[], members: Array<{ sys_user_id: number; nickname: string }>): MatchResult {
  const keyed = members.filter((m) => m.sys_user_id && m.nickname)
    .map((m) => ({ id: Number(m.sys_user_id), name: m.nickname, key: normName(stripDept(m.nickname)), full: normName(m.nickname) }))
  const cands = candidates.map((c) => (c || '').trim()).filter(Boolean)
  for (const c of cands) {
    const core = normName(stripDept(c))
    const full = normName(c)
    const hits = keyed.filter((m) => (core && m.key === core) || m.full === full)
    const ids = [...new Set(hits.map((h) => h.id))]
    if (ids.length === 1) return { sysUserId: ids[0], how: 'exact', name: hits[0].name }
    if (ids.length > 1) return { sysUserId: 0, ambiguous: ids.map((id) => hits.find((h) => h.id === id)!.name) }
  }
  for (const c of cands) {
    const n = normName(c)
    const hits = keyed.filter((m) => m.key.length >= 2 && n.includes(m.key))
    if (!hits.length) continue
    const maxLen = Math.max(...hits.map((h) => h.key.length))
    const longest = hits.filter((h) => h.key.length === maxLen)
    const ids = [...new Set(longest.map((h) => h.id))]
    if (ids.length === 1) return { sysUserId: ids[0], how: 'contains', name: longest[0].name }
    return { sysUserId: 0, ambiguous: ids.map((id) => longest.find((h) => h.id === id)!.name) }
  }
  return { sysUserId: 0 }
}

export interface GroupSyncResult {
  rooms: number
  messages: number
  /** 群里说过话的员工（企微账号）数 */
  staff: number
  gaps: ArchiveGap[]
  warnings: string[]
}

export interface GroupProgress { runId: number; phase: 'rooms' | 'messages' | 'save'; done: number; total: number; startedAt: number }
const running = new Map<string, GroupProgress>()
export const groupProgress = (deptCode: string): GroupProgress | null => running.get(deptCode) ?? null

/** 同步一个部门的对公群（[begin, end] 里的群消息） */
async function doSync(dept: Department, projectId: string, begin: number, end: number, progress: GroupProgress): Promise<GroupSyncResult> {
  const cfg = await getDeptSetting(dept.code, 'archive')
  const gc = await getGroupConfig(dept)
  const t = now()

  // ① 哪些群算
  progress.phase = 'rooms'
  const groups = await fetchGroups(cfg)
  const rooms = new Map<string, string>()
  if (gc.roomFilterMode === 'manual') {
    const chosen = new Set(gc.selectedRooms)
    for (const g of groups) if (chosen.has(g.room_id)) rooms.set(g.room_id, g.room_name)
  } else {
    const kw = gc.roomKeyword.trim()
    const cands = groups.filter((g) => !kw || (g.room_name || '').includes(kw))
    progress.total = cands.length
    for (const g of cands) {
      // 全是员工的内部群（告警群等）不算；成员快照还没到的群先算上，宁多勿漏
      try {
        const ms = await fetchGroupMembers(cfg, g.room_id)
        if (ms.length && ms.every((m) => m.is_staff === 1)) { progress.done++; continue }
      } catch { /* 拉不到成员就先算上 */ }
      rooms.set(g.room_id, g.room_name)
      progress.done++
    }
  }

  // ② 拉消息
  progress.phase = 'messages'
  progress.done = 0
  progress.total = 0
  const all = await fetchMessagesByRange(cfg, begin, end)
  const byRoom = new Map<string, ArchiveMessage[]>()
  for (const m of all) {
    if (!rooms.has(m.room_id)) continue
    let list = byRoom.get(m.room_id)
    if (!list) byRoom.set(m.room_id, (list = []))
    list.push(m)
  }

  // ②-b 原始消息存下来（AI 整理群问题用）
  progress.phase = 'save'
  const keep = [...byRoom.values()].flat()
  for (let i = 0; i < keep.length; i += 500) {
    const batch = keep.slice(i, i + 500)
    await execute(
      `INSERT INTO wg_messages (msg_id, room_id, sender_id, sender_name, is_staff, is_self, msg_type, content, at_list, refer_id, send_time)
       VALUES ?
       ON DUPLICATE KEY UPDATE sender_name = VALUES(sender_name), is_staff = VALUES(is_staff), content = VALUES(content),
         at_list = VALUES(at_list), refer_id = VALUES(refer_id)`,
      [batch.map((m) => [m.msg_id.slice(0, 128), m.room_id.slice(0, 128), (m.sender_id || '').slice(0, 128), (m.sender_name || '').slice(0, 128),
        m.is_staff ? 1 : 0, m.is_self ? 1 : 0, m.msg_type || 0, m.content || '', JSON.stringify(m.at_list || []), (m.refer_id || '').slice(0, 128), m.send_time])]
    )
  }

  // ③ 员工挂靠：群昵称优先；手动指定的不覆盖
  const members = await query<{ sys_user_id: number; nickname: string; department_id: number | null; participate: number; active: number }>(
    'SELECT sys_user_id, nickname, department_id, participate, active FROM members WHERE project_id = ?', [projectId]
  )
  const assessed = new Set(members.filter((m) => m.department_id === dept.id && m.participate && m.active).map((m) => Number(m.sys_user_id)))
  const groupNicks = new Map<string, string>()
  try {
    for (const s of await fetchStaff(cfg)) if (s.user_id && s.nickname) groupNicks.set(s.user_id, s.nickname)
  } catch { /* 拉不到群昵称就只用个人昵称 */ }
  const filtered = [...byRoom.values()].flat()
  const staffSeen = new Map<string, string>()
  const replies = new Map<string, number>()
  const lastSaid = new Map<string, number>()
  for (const m of filtered) {
    if (m.is_staff === 1 && m.is_self !== 1 && m.sender_id) {
      staffSeen.set(m.sender_id, m.sender_name || '')
      replies.set(m.sender_id, (replies.get(m.sender_id) || 0) + 1)
      lastSaid.set(m.sender_id, Math.max(lastSaid.get(m.sender_id) || 0, m.send_time))
    }
  }
  const saved = await query<{ user_id: string; sys_user_id: number; manual: number }>('SELECT user_id, sys_user_id, manual FROM wg_staff')
  const savedBy = new Map(saved.map((r) => [r.user_id, r]))
  const mapping = new Map<string, number>(saved.map((r) => [r.user_id, Number(r.sys_user_id)]))
  for (const [userId, rawName] of staffSeen) {
    const nick = groupNicks.get(userId) || rawName
    const old = savedBy.get(userId)
    let sysUserId = old ? Number(old.sys_user_id) : 0
    if (!old?.manual && !sysUserId && members.length) {
      const r = matchMember([groupNicks.get(userId) || '', rawName], members)
      sysUserId = r.sysUserId
    }
    mapping.set(userId, sysUserId)
    await execute(
      `INSERT INTO wg_staff (user_id, nickname, raw_name, sys_user_id, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), raw_name = VALUES(raw_name),
         sys_user_id = IF(manual = 1, sys_user_id, VALUES(sys_user_id)), last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at))`,
      [userId.slice(0, 128), nick.slice(0, 128), rawName.slice(0, 128), sysUserId, lastSaid.get(userId) || 0]
    )
  }

  // 提醒：像技术支持的人没挂上 / 分不清；挂上了但不是本部门参与考核的
  const warnings: string[] = []
  const notAssessed: string[] = []
  const byId = new Map(members.map((m) => [Number(m.sys_user_id), m]))
  for (const [userId, rawName] of staffSeen) {
    const nick = groupNicks.get(userId) || rawName
    const id = mapping.get(userId) || 0
    if (id) {
      if (!assessed.has(id)) {
        const m = byId.get(id)
        if (m && (m.department_id === dept.id || TECH_NICK_RE.test(nick))) notAssessed.push(`${m.nickname}（${replies.get(userId) || 0} 条）`)
      }
      continue
    }
    if (TECH_NICK_RE.test(nick)) {
      const r = matchMember([groupNicks.get(userId) || '', rawName], members)
      warnings.push('ambiguous' in r
        ? `「${nick}」同时能对上 ${[...new Set(r.ambiguous)].join('、')}，分不清是谁，请在「员工挂靠」里手动指定`
        : `「${nick}」在 SaleSmartly 成员里找不到对应的人，他的群回复不会计入，请在「员工挂靠」里手动指定`)
    }
  }
  if (notAssessed.length) warnings.push(`${notAssessed.join('、')} 在群里回复了，但不是本部门参与考核的人，回复不计入`)

  const r: GroupSyncResult = { rooms: rooms.size, messages: filtered.length, staff: staffSeen.size, gaps: [], warnings }

  // 每 10 分钟一条同步记录，只留最近 14 天
  await execute("DELETE FROM sync_runs WHERE source = 'wg' AND started_at < ?", [t - 14 * 86400]).catch(() => undefined)

  try {
    r.gaps = await fetchGaps(cfg, begin, Math.min(end, t))
  } catch { /* 拉不到中断区间不影响结果 */ }
  return r
}

export class GroupBusyError extends Error {}

/** 开始同步（后台跑，立刻返回 runId） */
export async function startGroupSync(dept: Department, begin: number, end: number, trigger: 'auto' | 'manual', by: string): Promise<number> {
  if (!dept.groupChat) throw new Error('本部门没有开对公群')
  if (running.has(dept.code)) throw new GroupBusyError('对公群正在同步，等这次跑完再试')
  if (!isSectionConfigured('archive', await getDeptSetting(dept.code, 'archive'))) throw new Error('还没有配好群聊归档服务（设置 → 数据源与 AI）')
  const projectId = await deptProjectId(dept)
  if (!projectId) throw new Error('本部门还没有填 SaleSmartly 项目（群问题要挂到 SaleSmartly 成员名下）')
  const progress: GroupProgress = { runId: 0, phase: 'rooms', done: 0, total: 0, startedAt: now() }
  running.set(dept.code, progress)
  try {
    const res = await execute(
      `INSERT INTO sync_runs (project_id, source, \`trigger\`, triggered_by, range_begin, range_end, status, started_at)
       VALUES (?, 'wg', ?, ?, ?, ?, 'running', ?)`,
      [`${projectId}:${dept.code}`, trigger, by, begin, end, progress.startedAt]
    )
    progress.runId = res.insertId
  } catch (err) {
    running.delete(dept.code)
    throw err
  }
  void (async () => {
    let result: GroupSyncResult | null = null
    let error: string | null = null
    try {
      result = await doSync(dept, projectId, begin, end, progress)
    } catch (err) {
      error = describeFetchError(err)
      console.error(`[group] ${dept.name} 对公群同步失败：${error}`)
    } finally {
      await execute(
        `UPDATE sync_runs SET status = ?, finished_at = ?, sessions_fetched = ?, sessions_new = ?, messages_synced = ?, error = ?, detail = CAST(? AS JSON) WHERE id = ?`,
        [error ? 'failed' : 'success', now(), 0, 0, result?.messages ?? 0, error, JSON.stringify(result), progress.runId]
      ).catch((e) => console.error('[group] 写同步记录失败', e))
      running.delete(dept.code)
      if (result) {
        // 员工挂靠可能变了：会话记录里的群问题对一遍；再看有没有聊完的群要分析（分析完也会对一遍）
        refreshIssueSessions(dept).catch((e) => console.error('[issues] 群问题写进会话记录失败', e))
        autoAnalyze().catch((e) => console.error('[issues] 自动分析出错', e))
      }
      if (result) console.log(`[group] ${dept.name} 对公群同步结束：群 ${result.rooms} 个，消息 ${result.messages} 条`)
    }
  })()
  return progress.runId
}

function monthStart(): number {
  const d = new Date()
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000)
}

async function autoOnce(): Promise<void> {
  for (const dept of await listDepartments()) {
    if (!dept.groupChat || running.has(dept.code)) continue
    const projectId = await deptProjectId(dept)
    if (!projectId) continue
    const [done] = await query<{ n: number }>(
      "SELECT COUNT(*) n FROM sync_runs WHERE project_id = ? AND source = 'wg' AND status = 'success'", [`${projectId}:${dept.code}`]
    )
    const end = now()
    const begin = Number(done?.n) > 0 ? end - AUTO_LOOKBACK_SEC : monthStart()
    try {
      await startGroupSync(dept, begin, end, 'auto', '')
    } catch (err) {
      console.error(`[group] ${dept.name} 自动同步没能开始：${(err as Error).message}`)
    }
  }
}

/** 每 10 分钟同步一次对公群（启动 2 分钟后第一轮），同步完自动分析 */
export function startGroupScheduler(): void {
  const tick = (): void => { autoOnce().catch((e) => console.error('[group] 自动同步出错', e)) }
  setTimeout(tick, 2 * 60 * 1000)
  setInterval(tick, AUTO_INTERVAL_MS)
}
