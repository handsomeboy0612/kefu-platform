/**
 * 绩效考核用的本地数据（口径和桌面版 db-service 一致）：
 * - 回复率本地口径、出勤天数、差评剔除：按「分配时间（没有就用开始时间）」落在时段内的会话
 * - AI 质检：按会话时间和时段有重叠的已评分会话
 */
import type { GroupStats } from './calc-tech'
import { query } from '../db'

/** 预筛：分配时间一定不早于开始时间，按开始时间先圈一个范围走索引（往前多放 7 天） */
const ANCHOR = 'IF(s.assign_time > 0, s.assign_time, s.start_time)'
const PREFILTER = 's.start_time BETWEEN ? AND ?'
const pre = (begin: number, end: number): [number, number] => [begin - 7 * 86400, end]

export interface ReplyStat { den: number; num: number; graced: number; uncached: number }

/**
 * 回复率本地口径（按负责客服）：
 * - 只算客户说过话的会话；是否人工回复看聊天记录里有没有客服（未撤回）发言
 * - 没回复、且存活时间（结束 − 分配）< graceSec 的秒退会话不进分母；人工剔除的同样不进
 * - 还没拉到聊天记录的回退用平台的客服消息数判断（含自动消息，偏宽），记 uncached
 */
export async function replyStats(projectId: string, begin: number, end: number, graceSec: number): Promise<Record<string, ReplyStat>> {
  const rows = await query<{ uid: number; anchor: number; end_time: number; msgs_synced: number; kf_msg_count: number; staff: number; exempt: number }>(
    `SELECT s.sys_user_id uid, ${ANCHOR} anchor, s.end_time, s.msgs_synced, s.kf_msg_count,
            EXISTS (SELECT 1 FROM ss_messages m WHERE m.project_id = s.project_id AND m.session_id = s.session_id AND m.sender_type = 'staff' AND m.recalled = 0) staff,
            EXISTS (SELECT 1 FROM kpi_exemptions e WHERE e.project_id = s.project_id AND e.session_id = s.session_id AND e.kind = 'reply') exempt
     FROM ss_sessions s
     WHERE s.project_id = ? AND s.source = 'ss' AND ${PREFILTER} AND s.sys_user_id > 0 AND s.user_msg_count > 0 AND s.end_time > 0
       AND ${ANCHOR} BETWEEN ? AND ?`,
    [projectId, ...pre(begin, end), begin, end]
  )
  const acc: Record<string, ReplyStat> = {}
  for (const r of rows) {
    const k = String(r.uid)
    const a = (acc[k] ||= { den: 0, num: 0, graced: 0, uncached: 0 })
    let replied: boolean
    if (r.msgs_synced) replied = !!r.staff
    else { a.uncached++; replied = r.kf_msg_count > 0 }
    if (!replied && (Number(r.end_time) - Number(r.anchor) < graceSec || r.exempt)) { a.graced++; continue }
    a.den++
    if (replied) a.num++
  }
  return acc
}

/** 出勤天数：时段内「当天有接待」就算 1 天（MySQL 会话时区是北京时间） */
export async function activeDays(projectId: string, begin: number, end: number): Promise<Record<string, number>> {
  const rows = await query<{ uid: number; days: number }>(
    `SELECT s.sys_user_id uid, COUNT(DISTINCT DATE(FROM_UNIXTIME(${ANCHOR}))) days
     FROM ss_sessions s WHERE s.project_id = ? AND s.source = 'ss' AND ${PREFILTER} AND s.sys_user_id > 0 AND ${ANCHOR} BETWEEN ? AND ?
     GROUP BY s.sys_user_id`,
    [projectId, ...pre(begin, end), begin, end]
  )
  return Object.fromEntries(rows.map((r) => [String(r.uid), Number(r.days)]))
}

/** 差评剔除（按负责客服）：剔除条数和这些会话的真实星级和（按真实星级扣减） */
export async function badReviewExempts(projectId: string, begin: number, end: number): Promise<Record<string, { cnt: number; sumStar: number }>> {
  const rows = await query<{ uid: number; cnt: number; sum_star: number }>(
    `SELECT s.sys_user_id uid, COUNT(*) cnt, SUM(s.star_score) sum_star
     FROM kpi_exemptions e JOIN ss_sessions s ON s.project_id = e.project_id AND s.session_id = e.session_id
     WHERE e.project_id = ? AND e.kind = 'bad_review' AND s.star_score > 0 AND s.sys_user_id > 0
       AND ${PREFILTER} AND ${ANCHOR} BETWEEN ? AND ?
     GROUP BY s.sys_user_id`,
    [projectId, ...pre(begin, end), begin, end]
  )
  return Object.fromEntries(rows.map((r) => [String(r.uid), { cnt: Number(r.cnt), sumStar: Number(r.sum_star) }]))
}

/** AI 质检（按负责客服）：中位数、平均分、条数。会话时间和时段有重叠就算 */
export async function aiScores(projectId: string, begin: number, end: number): Promise<Record<string, { median: number; avg: number; count: number }>> {
  const rows = await query<{ uid: number; total: string | number }>(
    `SELECT s.sys_user_id uid, sc.total_score total
     FROM ss_sessions s JOIN ai_scores sc ON sc.project_id = s.project_id AND sc.session_id = s.session_id AND sc.status = 'ok'
     WHERE s.project_id = ? AND s.source = 'ss' AND s.sys_user_id > 0 AND s.start_time <= ?
       AND IF(s.end_time > 0, s.end_time >= ?, s.start_time >= ?)`,
    [projectId, end, begin, begin]
  )
  const by: Record<string, number[]> = {}
  for (const r of rows) (by[String(r.uid)] ||= []).push(Number(r.total))
  const out: Record<string, { median: number; avg: number; count: number }> = {}
  for (const [k, xs] of Object.entries(by)) {
    const sorted = [...xs].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    out[k] = { median, avg: xs.reduce((a, b) => a + b, 0) / xs.length, count: xs.length }
  }
  return out
}

/** 时段内本地会话总数、已 AI 评分数（生成报表前提示覆盖率用） */
export async function coverage(projectId: string, deptId: number, begin: number, end: number): Promise<{ total: number; scored: number; eligible: number }> {
  const [r] = await query<{ total: number; scored: number; eligible: number }>(
    `SELECT COUNT(*) total, SUM(sc.status = 'ok') scored,
            SUM(s.user_msg_count > 0 AND m.participate = 1 AND m.active = 1) eligible
     FROM ss_sessions s
     JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
     LEFT JOIN ai_scores sc ON sc.project_id = s.project_id AND sc.session_id = s.session_id
     WHERE s.project_id = ? AND s.source = 'ss' AND s.start_time BETWEEN ? AND ?`,
    [deptId, projectId, begin, end]
  )
  return { total: Number(r?.total || 0), scored: Number(r?.scored || 0), eligible: Number(r?.eligible || 0) }
}

/**
 * 对公群（技术支持部第二项，按 AI 群问题算）：每人处理的群问题（处理人按主管改过的），问题按客户第一条提问的时间算在哪天。
 * 首响 / 均响 / 处理时长在把群问题写进会话记录时已经算好（issues/sessions.ts）。
 */
export async function issueStats(projectId: string, deptId: number, begin: number, end: number): Promise<GroupStats> {
  const rows = await query<{ sys_user_id: number; room_id: string; nickname: string; issue_status: string; issue_first_sec: number | null; issue_avg_sec: number | null; issue_resolve_sec: number | null; issue_sync_gap_sec: number | null; issue_difficulty: number }>(
    `SELECT s.sys_user_id, s.room_id, m.nickname, s.issue_status, s.issue_first_sec, s.issue_avg_sec, s.issue_resolve_sec, s.issue_sync_gap_sec, s.issue_difficulty
     FROM ss_sessions s
     JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
     WHERE s.project_id = ? AND s.source = 'wg' AND s.assign_time BETWEEN ? AND ?`,
    [deptId, projectId, begin, end]
  )
  const acc: Record<string, { name: string; rooms: Set<string>; threads: GroupStats[string]['threads'] }> = {}
  const n = (v: number | null): number | null => (v == null ? null : Number(v))
  for (const r of rows) {
    const a = (acc[String(r.sys_user_id)] ||= { name: r.nickname, rooms: new Set(), threads: [] })
    a.rooms.add(r.room_id)
    a.threads.push({
      firstSec: n(r.issue_first_sec), avgSec: n(r.issue_avg_sec), status: r.issue_status || 'unknown',
      resolveSec: n(r.issue_resolve_sec), syncGapSec: n(r.issue_sync_gap_sec), difficulty: Number(r.issue_difficulty) || 1
    })
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { name: v.name, roomCnt: v.rooms.size, threads: v.threads }]))
}

/**
 * 对公群（技术支持部第二项）：按规则切的群会话（source = 'wgr'，核对准确率达标后改成按 AI 群问题）。每人接手的群会话、涉及的群数，以及每个群会话的首响 / 均响（秒）。
 * 等待从客户发言算起（客户连着发、间隔不超过 60 秒的算一轮，从这一轮最后一句算）到客服回复；派单等系统消息不算。
 */
export async function groupStats(projectId: string, deptId: number, begin: number, end: number): Promise<GroupStats> {
  const sessions = await query<{ session_id: string; sys_user_id: number; room_id: string; nickname: string }>(
    `SELECT s.session_id, s.sys_user_id, s.room_id, m.nickname FROM ss_sessions s
     JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
     WHERE s.project_id = ? AND s.source = 'wgr' AND s.start_time BETWEEN ? AND ?`,
    [deptId, projectId, begin, end]
  )
  if (!sessions.length) return {}
  const msgs = await query<{ session_id: string; sender_type: string; send_time: number }>(
    `SELECT session_id, sender_type, send_time FROM ss_messages
     WHERE project_id = ? AND session_id IN (?) AND sender_type IN ('customer', 'staff') ORDER BY session_id, send_time, id`,
    [projectId, sessions.map((s) => s.session_id)]
  )
  const bySession = new Map<string, Array<{ t: string; at: number }>>()
  for (const m of msgs) {
    let l = bySession.get(m.session_id)
    if (!l) bySession.set(m.session_id, (l = []))
    l.push({ t: m.sender_type, at: Number(m.send_time) })
  }
  const acc: Record<string, { name: string; rooms: Set<string>; threads: Array<{ firstSec: number | null; avgSec: number | null }> }> = {}
  for (const s of sessions) {
    const key = String(s.sys_user_id)
    const a = (acc[key] ||= { name: s.nickname, rooms: new Set(), threads: [] })
    a.rooms.add(s.room_id)
    const waits: number[] = []
    let pending: number[] = []
    for (const m of bySession.get(s.session_id) || []) {
      if (m.t === 'customer') pending.push(m.at)
      else if (pending.length) {
        let start = pending[0]
        for (let i = 1; i < pending.length && pending[i] - pending[i - 1] <= 60; i++) start = pending[i]
        waits.push(Math.max(0, m.at - start))
        pending = []
      }
    }
    a.threads.push({
      firstSec: waits.length ? waits[0] : null,
      avgSec: waits.length ? Math.round(waits.reduce((x, y) => x + y, 0) / waits.length) : null
    })
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { name: v.name, roomCnt: v.rooms.size, threads: v.threads }]))
}
