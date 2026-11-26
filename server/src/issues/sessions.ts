/**
 * 会话记录里的对公群 = AI 整理出的群问题：一个问题一行（source = 'wg'，渠道 -2），挂在处理人名下。
 * - 处理人按主管改过的算；只挂本部门成员处理的问题（商务等处理的、没人处理的只在「群问题」里看）
 * - 按规则切的群会话（source = 'wgr'）留作对照，不在会话记录里出现；考核规则里可以切回按它给第二项计分
 * 群问题有变化（分析完、主管改了处理人 / 状态、员工挂靠变了）就对一遍；内容指纹没变的不动。
 * 同时按处理人算好首次响应 / 平均响应 / 处理时长 / 最长没同步进度的时间，绩效第二项和会话记录里的单题分直接用。
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
  handler_user_id: string; status: string; first_customer_at: number; resolved_at: number; override_handler: string | null; override_status: string | null
  difficulty: number | null
}

export interface IssueMsg { msg_id: string; sender_id: string; is_staff: number; is_self: number; at_list: unknown; content: string; send_time: number }
export interface IssueMetrics {
  firstCustomerAt: number; firstSec: number | null; avgSec: number | null; resolveSec: number | null; syncGapSec: number | null
  start: number; end: number; customerCnt: number; staffCnt: number
}

/** 算时间要用的：认识的员工（判断「只 @ 同事的派单」） */
export interface MetricsCtx { staffIds: Set<string> }

/** 去掉 @、表情、标点后的正文（判断客户是不是只回了「好的」、处理人是不是只回了「稍等」） */
const core = (content: string): string =>
  (content || '').replace(/@\S+/g, '').replace(/\[[^\]]{1,8}\]/g, '').replace(/[\s，。,.!！?？~～…、:：;；'"“”‘’()（）\-—]/g, '')
/** 图片、文件这类算有内容（报错截图要回）；看不到内容的「[类型104消息]」「[消息]」不算 */
const MEDIA_RE = /\[(图片|文件|视频|语音)\]/
/** 客户只回了「好的」「谢谢」这类，不用回复，不算一轮提问 */
const ACK_RE = /^(好的?|好嘞|好滴|好吧|ok|okay|嗯+|哦+|噢+|收到|谢谢|谢了|感谢|多谢|辛苦了?|了解|明白了?|知道了|行吧?|可以了?|没问题|thx|thanks)+$/i
/** 客户说「我们看看」「我试试」「我等下复现一下」，又没在问，是客户自己去弄，不等我方回复 */
const INTENT_RE = /(我|我们)(先|再|等下|等会儿?|这边|回头)?(去|来)?(看看|看下|看一下|试试|试一下|测一下|测试一下|复现一下|跑一下|跑下|加一下|研究一下|确认一下|排查一下)/
const QUESTION_RE = /[？?]|吗|为什么|怎么回事|是不是/
/** 处理人只回「稍等」「还在看」这类，不算同步进度 */
const HOLD_RE = /^(稍等|等下|等一下|等等|收到|好的?|好嘞|ok|嗯+|在看|还在看|正在看|看下|看一下|看看|我看看|我看下|我看一下|我来看看?|马上|在查|查下|查一下|我查下|我查一下|在处理|处理中|还在处理|还在查|还在排查|排查中|在排查)+$/i

/**
 * 按处理人算一个群问题的时间（《技术支持部绩效考核标准》第三部分；值班时间按全天有人算）：
 * - 首次响应：从商务、主管或客户 @ 处理人让他看（派单）开始算；没人 @ 他、他自己接的，从客户这一轮提问开始算（同一客户 1 分钟内
 *   连发的算一条，从最后一条算；前面已经有我方的人回过的不算）→ 处理人第一次回应（「收到，正在看」「稍等」也算；只 @ 同事的派单不算）
 * - 平均响应：接手之后客户每一轮提问 → 处理人下一次回应，取平均（含首次响应）；别的同事先回了的那一轮不算；
 *   客户只回「好的」「谢谢」、说「我们看看」「我试试」（没在问）、发看不到内容的消息，不算提问
 * - 处理时效：首次响应 → 解决那条消息（只算已解决的）；同时记下期间处理人最长多久没同步进度（只回「稍等」「还在看」不算同步）
 */
export function issueMetrics(msgs: IssueMsg[], handler: string, ctx: MetricsCtx, status: string, resolvedAt: number): IssueMetrics {
  const { staffIds } = ctx
  const sorted = [...msgs].sort((a, b) => Number(a.send_time) - Number(b.send_time))
  const isCustomer = (m: IssueMsg): boolean => !m.is_staff && !m.is_self
  const atIds = (m: IssueMsg): string[] => json<Array<{ user_id: string }>>(m.at_list, []).map((a) => a.user_id).filter(Boolean)
  const dispatchOnly = (m: IssueMsg): boolean => { const ats = atIds(m); return ats.length > 0 && ats.every((id) => staffIds.has(id)) }
  const isAck = (m: IssueMsg): boolean => {
    if (atIds(m).length || MEDIA_RE.test(m.content || '')) return false
    const c = core(m.content)
    return c === '' || ACK_RE.test(c) || (INTENT_RE.test(m.content || '') && !QUESTION_RE.test(m.content || ''))
  }
  const isProgress = (m: IssueMsg): boolean => MEDIA_RE.test(m.content || '') || (core(m.content) !== '' && !HOLD_RE.test(core(m.content)))
  const roundStart = (p: number[]): number => {
    let st = p[0]
    for (let i = 1; i < p.length && p[i] - p[i - 1] <= 60; i++) st = p[i]
    return st
  }

  const fc = sorted.find(isCustomer)
  const firstCustomerAt = fc ? Number(fc.send_time) : 0
  let pending: number[] = []
  let calledAt = 0
  let firstReplyAt = 0
  let firstSec: number | null = null
  const waits: number[] = []
  const progress: number[] = []
  for (const m of sorted) {
    if (m.is_self) continue
    const at = Number(m.send_time)
    const ats = atIds(m)
    if (isCustomer(m)) {
      if (!firstReplyAt && handler && !calledAt && ats.includes(handler)) calledAt = at
      if (!isAck(m)) pending.push(at)
      continue
    }
    if (handler && m.sender_id === handler) {
      if (dispatchOnly(m)) continue
      if (!firstReplyAt) {
        firstReplyAt = at
        const from = calledAt || (pending.length ? roundStart(pending) : 0)
        firstSec = from ? Math.max(0, at - from) : null
        if (firstSec !== null) waits.push(firstSec)
      } else {
        if (pending.length) waits.push(Math.max(0, at - roundStart(pending)))
        if (isProgress(m)) progress.push(at)
      }
      pending = []
      continue
    }
    // 别的员工：@ 了处理人 = 派单，从这时开始算；回了客户（不是只 @ 同事）= 这一轮已经有人回了
    if (!firstReplyAt && handler && !calledAt && ats.includes(handler)) calledAt = at
    if (!dispatchOnly(m)) pending = []
  }

  let resolveSec: number | null = null
  let syncGapSec: number | null = null
  if (status === 'resolved' && resolvedAt && firstReplyAt) {
    const endAt = Math.max(Number(resolvedAt), firstReplyAt)
    resolveSec = endAt - firstReplyAt
    const pts = [firstReplyAt, ...progress.filter((t) => t > firstReplyAt && t < endAt), endAt]
    syncGapSec = Math.max(0, ...pts.slice(1).map((t, i) => t - pts[i]))
  }
  const times = sorted.map((m) => Number(m.send_time))
  return {
    firstCustomerAt,
    firstSec,
    avgSec: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    resolveSec,
    syncGapSec,
    start: times.length ? times[0] : firstCustomerAt,
    end: times.length ? times[times.length - 1] : firstCustomerAt,
    customerCnt: sorted.filter(isCustomer).length,
    staffCnt: sorted.filter((m) => m.is_staff && !m.is_self).length
  }
}

export async function metricsCtx(): Promise<MetricsCtx> {
  return { staffIds: new Set((await query<{ user_id: string }>('SELECT user_id FROM wg_staff')).map((r) => r.user_id)) }
}

async function refresh(dept: Department): Promise<{ upserted: number; removed: number }> {
  const projectId = await deptProjectId(dept)
  if (!dept.groupChat || !projectId) return { upserted: 0, removed: 0 }
  const issues = await query<Row>(
    `SELECT i.id, i.room_id, i.room_name, i.anchor_msg_id, i.summary, i.message_ids, i.handler_user_id, i.status, i.first_customer_at,
            i.resolved_at, k.override_handler, k.override_status, k.difficulty
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
  const ctx = await metricsCtx()

  const want = new Map<string, { r: Row; handler: string; sysUserId: number; status: string; msgIds: string[]; sig: string }>()
  for (const r of issues) {
    const handler = r.override_handler !== null && r.override_handler !== undefined ? r.override_handler : r.handler_user_id
    const sysUserId = handler ? memberOf.get(handler) || 0 : 0
    if (!sysUserId) continue
    const status = r.override_status || r.status
    const msgIds = json<string[]>(r.message_ids, [])
    const sig = sha(JSON.stringify(['m4', r.id, handler, sysUserId, status, Number(r.difficulty || 1), r.summary, r.room_name, msgIds, Number(r.first_customer_at), Number(r.resolved_at)]))
    want.set(issueSessionId(dept.id, r.room_id, r.anchor_msg_id), { r, handler, sysUserId, status, msgIds, sig })
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
    // 消息条数、起止时间、首响 / 均响 / 处理时长从原始群消息算
    const allIds = [...new Set(changed.flatMap(([, w]) => w.msgIds))]
    const info = new Map<string, IssueMsg>()
    for (let i = 0; i < allIds.length; i += 1000) {
      const rows = await query<IssueMsg>(
        'SELECT msg_id, sender_id, is_staff, is_self, at_list, content, send_time FROM wg_messages WHERE msg_id IN (?)', [allIds.slice(i, i + 1000)]
      )
      for (const m of rows) info.set(m.msg_id, m)
    }
    const t = now()
    const values = changed.map(([id, w]) => {
      const ms = w.msgIds.map((x) => info.get(x)).filter((x): x is IssueMsg => !!x)
      const x = issueMetrics(ms, w.handler, ctx, w.status, Number(w.r.resolved_at))
      const first = x.firstCustomerAt || Number(w.r.first_customer_at) || 0
      return [projectId, id, 'wg', w.r.room_id.slice(0, 128), w.sig, w.r.id, w.status, (w.r.summary || '').slice(0, 255),
        x.firstSec, x.avgSec, x.resolveSec, x.syncGapSec, Number(w.r.difficulty) || 1, '',
        (w.r.room_name || w.r.room_id).slice(0, 255), w.sysUserId, WG_CHANNEL, 0, x.start || first, x.end || first, first || x.start, 0, 0, '',
        ms.length, x.customerCnt, x.staffCnt, 1, 0, t]
    })
    for (let i = 0; i < values.length; i += 300) {
      await execute(
        `INSERT INTO ss_sessions (project_id, session_id, source, room_id, content_sig, issue_id, issue_status, issue_summary,
           issue_first_sec, issue_avg_sec, issue_resolve_sec, issue_sync_gap_sec, issue_difficulty, chat_user_id,
           customer_name, sys_user_id, channel, channel_id, start_time, end_time, assign_time, star_score, quality_score, tags,
           msg_count, user_msg_count, kf_msg_count, msgs_synced, msg_fail, synced_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE content_sig = VALUES(content_sig), issue_id = VALUES(issue_id), issue_status = VALUES(issue_status),
           issue_summary = VALUES(issue_summary), issue_first_sec = VALUES(issue_first_sec), issue_avg_sec = VALUES(issue_avg_sec),
           issue_resolve_sec = VALUES(issue_resolve_sec), issue_sync_gap_sec = VALUES(issue_sync_gap_sec), issue_difficulty = VALUES(issue_difficulty),
           customer_name = VALUES(customer_name), sys_user_id = VALUES(sys_user_id),
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
