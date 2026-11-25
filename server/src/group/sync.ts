/**
 * 对公群同步（从桌面版 wecom-group-sync-service 搬过来）：
 * 按时间段从群聊归档服务拉群消息 → 群筛选 → 按间隔切段 → 按「谁实际回复了」拆成群会话 → 存进 ss_sessions（source = 'wgr'，渠道 -2）。
 * 规则切的群会话只给技术支持部第二项计分，不在会话记录里出现；会话记录里的对公群是 AI 整理的群问题（issues/sessions.ts）。
 *
 * 口径（和桌面版一致）：
 * - 切段：同群相邻消息间隔 > 切段间隔（默认 30 分钟）断段；单段最长 24 小时；最后一条离现在不到切段间隔的段还没聊完，这次不存
 * - 拆分：客户 @ 了谁只表示在等谁；谁先回复，还没被领走的客户消息就归谁。回复里点名了某个客户，只带走那个客户
 * - 派单：只 @ 同事、没对客户说话（如「@技术支持部-蒋海军 跟进一下」），不算回复、不领走客户；这句作为系统消息放进领走的那条会话
 * - 接待人只认本部门勾了「参与考核」、还在项目里的成员；一段里对不上任何人就不存
 * - 员工 → 成员挂靠：群昵称去掉部门前缀后同名优先，再包含匹配（取最长）；分不清就不挂，列进提醒；手动指定的不覆盖
 * - 会话 ID = wg_{群}_{第一条消息 ID}；群聊没有满意度
 */
import { createHash } from 'crypto'
import { execute, now, query, transaction } from '../db'
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

export const WG_CHANNEL = -2
const ID_PREFIX = 'wg_'
const SEGMENT_MAX_SEC = 24 * 3600
/** 往前多拉一天：切段时能看到段的真正开头，只存开头落在同步时段里的段（之前的段上一轮已经存过） */
const PAD_SEC = 86400
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

/** 同群消息切段：相邻间隔 > gapSec 断段；单段最长 24 小时 */
function segment(msgs: ArchiveMessage[], gapSec: number): ArchiveMessage[][] {
  const out: ArchiveMessage[][] = []
  let cur: ArchiveMessage[] = []
  for (const m of msgs) {
    if (cur.length) {
      const prev = cur[cur.length - 1]
      if (m.send_time - prev.send_time > gapSec || m.send_time - cur[0].send_time > SEGMENT_MAX_SEC) {
        out.push(cur)
        cur = []
      }
    }
    cur.push(m)
  }
  if (cur.length) out.push(cur)
  return out
}

type Mapping = Map<string, number> // 企微 user_id → sys_user_id（0 = 没挂上）

/** 同一段里按「谁实际回复了」拆开（逻辑见文件头） */
function splitThreads(
  seg: ArchiveMessage[],
  mapping: Mapping,
  assessed: Set<number>,
  staffIds: Set<string>
): Array<{ ownerId: number; msgs: ArchiveMessage[]; notes: Map<string, string> }> {
  const techOf = (userId: string): number => {
    const id = mapping.get(userId) || 0
    return id > 0 && assessed.has(id) ? id : 0
  }
  const threads = new Map<number, ArchiveMessage[]>()
  const notes = new Map<number, Map<string, string>>()
  const holding = new Map<string, ArchiveMessage[]>()
  const owned = new Map<string, number>()
  let pendingDispatch: Array<{ msg: ArchiveMessage; text: string }> = []

  const take = (ownerId: number, msg: ArchiveMessage): void => {
    let list = threads.get(ownerId)
    if (!list) threads.set(ownerId, (list = []))
    if (!list.includes(msg)) list.push(msg)
  }
  const hold = (cid: string, msg: ArchiveMessage): void => {
    let list = holding.get(cid)
    if (!list) holding.set(cid, (list = []))
    list.push(msg)
  }
  const flushDispatch = (ownerId: number): void => {
    if (!pendingDispatch.length) return
    let n = notes.get(ownerId)
    if (!n) notes.set(ownerId, (n = new Map()))
    for (const d of pendingDispatch) { take(ownerId, d.msg); n.set(d.msg.msg_id, d.text) }
    pendingDispatch = []
  }
  const assign = (cid: string, ownerId: number): void => {
    if (owned.has(cid)) return
    owned.set(cid, ownerId)
    const pending = holding.get(cid)
    if (!pending) return
    for (const p of pending) take(ownerId, p)
    holding.delete(cid)
  }

  for (const m of seg) {
    if (m.is_self === 1) continue
    if (m.is_staff === 1) {
      const tech = techOf(m.sender_id)
      if (!tech) continue
      const addressed = new Set<string>()
      const atTech: string[] = []
      for (const at of m.at_list || []) {
        if (!at.user_id || at.user_id === m.sender_id) continue
        // @ 的是同事（员工或已挂靠的人）就算点名同事，不当成客户
        if (staffIds.has(at.user_id) || mapping.has(at.user_id)) { atTech.push(at.nickname || at.user_id); continue }
        addressed.add(at.user_id)
      }
      if (m.refer_id) {
        const referred = seg.find((x) => x.msg_id === m.refer_id)
        if (referred && referred.is_self !== 1 && referred.is_staff !== 1 && referred.sender_id) addressed.add(referred.sender_id)
      }
      if (atTech.length && !addressed.size) {
        const body = (m.content || '').trim()
        pendingDispatch.push({ msg: m, text: `派单：${m.sender_name || '技术支持'} → ${atTech.join('、')}${body ? `「${body.slice(0, 20)}」` : ''}` })
        continue
      }
      const knownOwners = new Set<number>()
      for (const cid of addressed) { const o = owned.get(cid); if (o) knownOwners.add(o) }
      const openOwners = new Set(owned.values())
      if (addressed.size && knownOwners.size === 1 && [...addressed].every((id) => owned.has(id))) {
        const o = [...knownOwners][0]
        flushDispatch(o); take(o, m)
      } else if (!addressed.size && !holding.size && openOwners.size === 1) {
        const o = [...openOwners][0]
        flushDispatch(o); take(o, m)
      } else {
        flushDispatch(tech)
        take(tech, m)
        for (const cid of addressed.size ? addressed : [...holding.keys()]) assign(cid, tech)
      }
      continue
    }
    if (!m.sender_id) continue
    const owner = owned.get(m.sender_id)
    if (owner) { take(owner, m); continue }
    hold(m.sender_id, m)
  }

  const out: Array<{ ownerId: number; msgs: ArchiveMessage[]; notes: Map<string, string> }> = []
  for (const [ownerId, msgs] of threads) {
    msgs.sort((a, b) => a.send_time - b.send_time || (a.msg_id < b.msg_id ? -1 : 1))
    out.push({ ownerId, msgs, notes: notes.get(ownerId) || new Map() })
  }
  return out
}

const senderType = (m: ArchiveMessage): 'bot' | 'staff' | 'customer' => (m.is_self === 1 ? 'bot' : m.is_staff === 1 ? 'staff' : 'customer')
/** 归档里的 msg_type：14 / 101 是图片，其余都已在机器人端转成文字 */
const toMsgType = (t: number): number => (t === 14 || t === 101 ? 2 : 1)

/** 存一条群会话（整段替换消息） */
async function saveThread(projectId: string, roomId: string, roomName: string, ownerId: number, msgs: ArchiveMessage[], notes: Map<string, string>): Promise<string> {
  const sessionId = `${ID_PREFIX}${roomId}_${msgs[0].msg_id}`.slice(0, 64)
  const rows = msgs.map((m) => ({
    mid: m.msg_id.slice(0, 64),
    senderType: notes.has(m.msg_id) ? 'system' : senderType(m),
    senderName: (m.sender_name || (m.is_self === 1 ? '机器人' : '客户')).slice(0, 128),
    content: notes.get(m.msg_id) || m.content || '[消息]',
    msgType: toMsgType(m.msg_type),
    sendTime: m.send_time
  }))
  // 内容没变（同一个人、同样的消息）就不重写，避免每 10 分钟把最近两天的群会话删了重写
  const sig = createHash('sha256').update(JSON.stringify([ownerId, roomName, rows])).digest('hex')
  const [old] = await query<{ content_sig: string }>('SELECT content_sig FROM ss_sessions WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
  if (old?.content_sig === sig) return sessionId
  const firstCustomer = msgs.find((m) => m.is_staff !== 1 && m.is_self !== 1)
  const userCnt = rows.filter((r) => r.senderType === 'customer').length
  const staffCnt = rows.filter((r) => r.senderType === 'staff').length
  const t = now()
  await transaction(async (conn) => {
    await conn.query(
      `INSERT INTO ss_sessions (project_id, session_id, source, room_id, content_sig, chat_user_id, customer_name, sys_user_id, channel, channel_id,
         start_time, end_time, assign_time, star_score, quality_score, tags, msg_count, user_msg_count, kf_msg_count, msgs_synced, msg_fail, synced_at)
       VALUES (?, ?, 'wgr', ?, ?, '', ?, ?, ?, 0, ?, ?, ?, 0, 0, '', ?, ?, ?, 1, 0, ?)
       ON DUPLICATE KEY UPDATE content_sig = VALUES(content_sig), customer_name = VALUES(customer_name), sys_user_id = VALUES(sys_user_id), start_time = VALUES(start_time),
         end_time = VALUES(end_time), assign_time = VALUES(assign_time), msg_count = VALUES(msg_count), user_msg_count = VALUES(user_msg_count),
         kf_msg_count = VALUES(kf_msg_count), msgs_synced = 1, synced_at = VALUES(synced_at)`,
      [projectId, sessionId, roomId.slice(0, 128), sig, (roomName || roomId).slice(0, 255), ownerId, WG_CHANNEL,
        msgs[0].send_time, msgs[msgs.length - 1].send_time, firstCustomer?.send_time || msgs[0].send_time, rows.length, userCnt, staffCnt, t]
    )
    await conn.query('DELETE FROM ss_messages WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
    await conn.query(
      `INSERT INTO ss_messages (project_id, session_id, mid, sender_type, sender_name, content, msg_type, send_time, image_url, recalled) VALUES ?`,
      [rows.map((r) => [projectId, sessionId, r.mid, r.senderType, r.senderName, r.content, r.msgType, r.sendTime, '', 0])]
    )
  }, { readCommitted: true })
  return sessionId
}

/** 删掉某个群在一段时间里、这次没有重新生成的旧群会话（拆分结果变了、接待人不再参与考核等） */
async function dropStale(projectId: string, roomId: string, from: number, to: number, keep: Set<string>): Promise<number> {
  const rows = await query<{ session_id: string }>(
    "SELECT session_id FROM ss_sessions WHERE project_id = ? AND source = 'wgr' AND room_id = ? AND start_time BETWEEN ? AND ?",
    [projectId, roomId, from, to]
  )
  const stale = rows.map((r) => r.session_id).filter((id) => !keep.has(id))
  for (const id of stale) {
    await transaction(async (conn) => {
      await conn.query('DELETE FROM ss_messages WHERE project_id = ? AND session_id = ?', [projectId, id])
      await conn.query('DELETE FROM ai_scores WHERE project_id = ? AND session_id = ?', [projectId, id])
      await conn.query('DELETE FROM ss_sessions WHERE project_id = ? AND session_id = ?', [projectId, id])
    }, { readCommitted: true })
  }
  return stale.length
}

export interface GroupSyncResult {
  rooms: number
  messages: number
  sessions: number
  skippedOpen: number
  skippedNoOwner: number
  removed: number
  gaps: ArchiveGap[]
  warnings: string[]
}

export interface GroupProgress { runId: number; phase: 'rooms' | 'messages' | 'save'; done: number; total: number; startedAt: number }
const running = new Map<string, GroupProgress>()
export const groupProgress = (deptCode: string): GroupProgress | null => running.get(deptCode) ?? null

/** 同步一个部门的对公群（会话开头落在 [begin, end] 里的段） */
async function doSync(dept: Department, projectId: string, begin: number, end: number, progress: GroupProgress): Promise<GroupSyncResult> {
  const cfg = await getDeptSetting(dept.code, 'archive')
  const gc = await getGroupConfig(dept)
  const gapSec = gc.gapMin * 60
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

  // ② 拉消息（往前多拉一天看段的开头）
  progress.phase = 'messages'
  progress.done = 0
  progress.total = 0
  const all = await fetchMessagesByRange(cfg, begin - PAD_SEC, end)
  const byRoom = new Map<string, ArchiveMessage[]>()
  for (const m of all) {
    if (!rooms.has(m.room_id)) continue
    let list = byRoom.get(m.room_id)
    if (!list) byRoom.set(m.room_id, (list = []))
    list.push(m)
  }

  // ②-b 原始消息存一份（AI 分问题用）
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
  const mapping: Mapping = new Map(saved.map((r) => [r.user_id, Number(r.sys_user_id)]))
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
  const staffIds = new Set<string>(groupNicks.keys())
  for (const m of filtered) if (m.is_staff === 1 && m.sender_id) staffIds.add(m.sender_id)

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

  // ④ 切段、拆分、存
  progress.phase = 'save'
  progress.done = 0
  progress.total = byRoom.size
  const r: GroupSyncResult = { rooms: rooms.size, messages: filtered.length, sessions: 0, skippedOpen: 0, skippedNoOwner: 0, removed: 0, gaps: [], warnings }
  for (const [roomId, msgs] of byRoom) {
    const segs = segment(msgs, gapSec)
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      // 开头不在同步时段里的段：上一轮已经处理过，不动
      if (seg[0].send_time < begin || seg[0].send_time > end) continue
      // 还没聊完：这次不存，等安静下来再按对话拆
      if (i === segs.length - 1 && t - seg[seg.length - 1].send_time < gapSec) { r.skippedOpen++; continue }
      const threads = splitThreads(seg, mapping, assessed, staffIds)
      const keep = new Set<string>()
      if (!threads.length) r.skippedNoOwner++
      for (const th of threads) {
        keep.add(await saveThread(projectId, roomId, rooms.get(roomId) || '', th.ownerId, th.msgs, th.notes))
        r.sessions++
      }
      r.removed += await dropStale(projectId, roomId, seg[0].send_time, seg[seg.length - 1].send_time, keep)
    }
    progress.done++
  }

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
  if (!projectId) throw new Error('本部门还没有填 SaleSmartly 项目（群会话要挂到 SaleSmartly 成员名下）')
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
        [error ? 'failed' : 'success', now(), result?.sessions ?? 0, result?.sessions ?? 0, result?.messages ?? 0, error, JSON.stringify(result), progress.runId]
      ).catch((e) => console.error('[group] 写同步记录失败', e))
      running.delete(dept.code)
      if (result) {
        // 员工挂靠可能变了：会话记录里的群问题对一遍；再看有没有聊完的群要分析（分析完也会对一遍）
        refreshIssueSessions(dept).catch((e) => console.error('[issues] 群问题写进会话记录失败', e))
        autoAnalyze().catch((e) => console.error('[issues] 自动分析出错', e))
      }
      if (result) console.log(`[group] ${dept.name} 对公群同步结束：群 ${result.rooms} 个，群会话 ${result.sessions} 个，未聊完 ${result.skippedOpen}，没人接 ${result.skippedNoOwner}，清掉旧的 ${result.removed}`)
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
