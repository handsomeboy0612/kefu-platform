/**
 * 绩效考核用的本地数据（口径和桌面版 db-service 一致）：
 * - 回复率本地口径、出勤天数、差评剔除：按「分配时间（没有就用开始时间）」落在时段内的会话
 * - AI 质检：按会话时间和时段有重叠的已评分会话
 */
import type { GroupFeedback, GroupStats, GroupThread } from './calc-tech'
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

/** 群问题按人拆开的一份（处理人一份；有交接的，交接人另有一份） */
export interface IssueCredit { sysUserId: number; name: string; participate: boolean; at: number; roomId: string; thread: GroupThread }

/**
 * 对公群的群问题按人拆开（技术支持部第二项、统计看板共用）：处理人按主管改过的算，没人接手的归当班负责人；
 * 问题按客户第一次提问的时间算在哪天。交接完整的，交接人和处理人各记 0.5 个；不完整 / 没交接，交接人记 0、处理人记 1，
 * 交接人那一份的闭环按交接情况算（完整 0.8、不完整 0.4、没交接 0）。
 * 首响 / 均响 / 处理时长在把群问题写进会话记录时已经算好（issues/sessions.ts）。
 */
export async function issueCredits(projectId: string, deptId: number, begin: number, end: number): Promise<IssueCredit[]> {
  const rows = await query<{
    sys_user_id: number; room_id: string; nickname: string; participate: number; active: number; at: number
    issue_status: string; issue_first_sec: number | null; issue_avg_sec: number | null; issue_resolve_sec: number | null; issue_sync_gap_sec: number | null
    issue_difficulty: number; issue_handed_from_sys: number; issue_handover: string; issue_upstream: number; issue_ignored1h: number; issue_ignored2h: number
    hf_name: string | null; hf_participate: number | null; hf_active: number | null
  }>(
    `SELECT s.sys_user_id, s.room_id, m.nickname, m.participate, m.active, s.assign_time at, s.issue_status, s.issue_first_sec, s.issue_avg_sec,
            s.issue_resolve_sec, s.issue_sync_gap_sec, s.issue_difficulty, s.issue_handed_from_sys, s.issue_handover, s.issue_upstream,
            s.issue_ignored1h, s.issue_ignored2h,
            h.nickname hf_name, h.participate hf_participate, h.active hf_active
     FROM ss_sessions s
     JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
     LEFT JOIN members h ON h.project_id = s.project_id AND h.sys_user_id = s.issue_handed_from_sys AND h.department_id = ? AND s.issue_handed_from_sys > 0
     WHERE s.project_id = ? AND s.source = 'wg' AND s.assign_time BETWEEN ? AND ?`,
    [deptId, deptId, projectId, begin, end]
  )
  const n = (v: number | null): number | null => (v == null ? null : Number(v))
  const out: IssueCredit[] = []
  for (const r of rows) {
    const difficulty = Number(r.issue_difficulty) || 1
    const handed = !!r.hf_name
    const full = handed && r.issue_handover === 'full'
    out.push({
      sysUserId: Number(r.sys_user_id), name: r.nickname, participate: !!r.participate && !!r.active, at: Number(r.at), roomId: r.room_id,
      thread: {
        firstSec: n(r.issue_first_sec), avgSec: n(r.issue_avg_sec), status: r.issue_status || 'unknown', resolveSec: n(r.issue_resolve_sec),
        syncGapSec: n(r.issue_sync_gap_sec), difficulty, upstream: !!Number(r.issue_upstream), share: full ? 0.5 : 1,
        ignored1h: Number(r.issue_ignored1h) || 0, ignored2h: Number(r.issue_ignored2h) || 0
      }
    })
    if (handed) {
      out.push({
        sysUserId: Number(r.issue_handed_from_sys), name: r.hf_name!, participate: !!r.hf_participate && !!r.hf_active, at: Number(r.at), roomId: r.room_id,
        thread: {
          firstSec: null, avgSec: null, kind: 'handover', difficulty, share: full ? 0.5 : 0,
          status: full ? 'handed' : r.issue_handover === 'part' ? 'handed_part' : 'unresolved',
          handoverMiss: r.issue_handover === 'none' ? 1 : 0
        }
      })
    }
  }
  return out
}

/** 技术支持部第二项：每人的群问题（含交接出去的那一份） */
export async function issueStats(projectId: string, deptId: number, begin: number, end: number): Promise<GroupStats> {
  const acc: Record<string, { name: string; rooms: Set<string>; threads: GroupThread[] }> = {}
  for (const c of await issueCredits(projectId, deptId, begin, end)) {
    const a = (acc[String(c.sysUserId)] ||= { name: c.name, rooms: new Set(), threads: [] })
    a.rooms.add(c.roomId)
    a.threads.push(c.thread)
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { name: v.name, roomCnt: v.rooms.size, threads: v.threads }]))
}

/**
 * 群里 AI 标出的客户反馈（投诉 / 抱怨 / 表扬），按消息时间落在时段里、针对本部门成员的，按人汇总。
 * 默认按 AI 的判断：能归到本人身上的算（表扬都算），上游故障、价格、产品政策引起的不算；主管改过的按主管的。
 */
export async function confirmedFeedback(projectId: string, deptId: number, begin: number, end: number): Promise<GroupFeedback> {
  const items = await feedbackItems(deptId)
  const staff = new Map((await query<{ user_id: string; sys_user_id: number }>(
    `SELECT w.user_id, w.sys_user_id FROM wg_staff w JOIN members m ON m.project_id = ? AND m.sys_user_id = w.sys_user_id AND m.department_id = ?`,
    [projectId, deptId]
  )).map((r) => [r.user_id, Number(r.sys_user_id)]))
  const out: GroupFeedback = {}
  for (const f of items) {
    if (!f.counted || f.at < begin || f.at > end) continue
    const uid = staff.get(f.target)
    if (!uid) continue
    const o = (out[String(uid)] ||= { complaint: 0, mild: 0, praise: 0 })
    o[f.kind as 'complaint' | 'mild' | 'praise']++
  }
  return out
}

export interface FeedbackItem {
  msgId: string; issueId: number; roomId: string; roomName: string; day: string; at: number; quote: string; reason: string
  aiKind: string; aiTarget: string; ownFault: boolean; handler: string
  /** 主管判的（null = 没改，按 AI 的）；kind / target 是主管改过的优先 */
  decision: 'ok' | 'no' | null; kind: string; target: string; by: string
  /** 计不计入：主管改过的按主管的，没改的按 AI（能归到本人的算） */
  counted: boolean
}

/** 一个部门全部 AI 标出的客户反馈 + 主管的判定 */
export async function feedbackItems(deptId: number): Promise<FeedbackItem[]> {
  const rows = await query<{ id: number; room_id: string; room_name: string; day: string; handler_user_id: string; feedback: unknown }>(
    'SELECT id, room_id, room_name, day, handler_user_id, feedback FROM wg_issues WHERE department_id = ? AND feedback IS NOT NULL AND JSON_LENGTH(feedback) > 0',
    [deptId]
  )
  const marks = new Map((await query<{ msg_id: string; decision: string; kind: string | null; target_user: string | null; updated_by: string }>(
    'SELECT msg_id, decision, kind, target_user, updated_by FROM wg_feedback_marks WHERE department_id = ?', [deptId]
  )).map((r) => [r.msg_id, r]))
  const out: FeedbackItem[] = []
  for (const r of rows) {
    const list = (typeof r.feedback === 'string' ? JSON.parse(r.feedback) : r.feedback) as Array<{ type: string; msg_id: string; target_id: string; own_fault: boolean; reason: string; at: number; quote: string }>
    for (const f of list || []) {
      const k = marks.get(f.msg_id)
      out.push({
        msgId: f.msg_id, issueId: r.id, roomId: r.room_id, roomName: r.room_name || r.room_id, day: r.day, at: Number(f.at) || 0, quote: f.quote || '', reason: f.reason || '',
        aiKind: f.type, aiTarget: f.target_id || '', ownFault: !!f.own_fault, handler: r.handler_user_id,
        decision: (k?.decision as 'ok' | 'no' | undefined) ?? null, kind: k?.kind || f.type, target: k?.target_user || f.target_id || r.handler_user_id, by: k?.updated_by || '',
        counted: k ? k.decision === 'ok' : !!f.own_fault || f.type === 'praise'
      })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}
