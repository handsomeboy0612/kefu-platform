/**
 * 会话记录里的对公群 = AI 整理出的群问题：一个问题一行（source = 'wg'，渠道 -2），挂在处理人名下。
 * - 处理人按主管改过的算；只挂本部门成员处理的问题（商务等处理的、没人处理的只在「群问题」里看）
 * 群问题有变化（分析完、主管改了处理人 / 状态、员工挂靠变了）就对一遍；内容指纹没变的不动。
 * 同时按处理人算好首次响应 / 平均响应 / 处理时长 / 最长没同步进度的时间，绩效第二项和会话记录里的单题分直接用。
 */
import { createHash } from 'crypto'
import { execute, now, query } from '../db'
import { listDepartments, type Department } from '../auth'
import { deptProjectId } from '../members'
import { dutyAt, getGroupConfig, type GroupConfig } from '../group/config'

const WG_CHANNEL = -2
const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T))
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 会话 ID：部门 + 群 + 问题第一条消息（重新分析后问题编号会变，第一条消息不变就还是这一行） */
export const issueSessionId = (deptId: number, roomId: string, anchor: string): string => `wgi_${deptId}_${sha(`${roomId}|${anchor}`).slice(0, 40)}`

interface Row extends IssueMarkFields {
  id: number; room_id: string; room_name: string; day: string; anchor_msg_id: string; summary: string; message_ids: unknown
  status: string; resolved_at: number
}

/** 算「现在的」处理人 / 状态 / 难度 / 交接 / 依赖上游要用的字段（wg_issues + wg_issue_marks） */
export interface IssueMarkFields {
  handler_user_id: string; status: string; first_customer_at: number
  handed_from?: string; handover?: string; upstream?: number; difficulty_ai?: number
  override_handler: string | null; override_status: string | null; difficulty: number | null
  override_handed_from?: string | null; override_handover?: string | null; override_upstream?: number | null; override_ignored?: number | null
}

/** 某个时间的当班负责人：roster = 按值班表；active = 没配值班表的时段，按前后 2 小时在对公群里回复最多的本部门参与考核的人 */
export type DutyFn = (sec: number) => { sysUserId: number; how: 'roster' | 'active' } | null

export async function dutyResolver(dept: Department, gc: GroupConfig): Promise<DutyFn> {
  const projectId = await deptProjectId(dept)
  const acts = await query<{ sys_user_id: number; send_time: number }>(
    `SELECT w.sys_user_id, m.send_time FROM wg_messages m
     JOIN wg_staff w ON w.user_id = m.sender_id AND w.sys_user_id > 0
     JOIN members mm ON mm.project_id = ? AND mm.sys_user_id = w.sys_user_id AND mm.department_id = ? AND mm.participate = 1 AND mm.active = 1
     WHERE m.is_staff = 1 AND m.is_self = 0`,
    [projectId, dept.id]
  )
  return (sec: number) => {
    if (!sec) return null
    const roster = dutyAt(gc, sec)
    if (roster) return { sysUserId: roster, how: 'roster' }
    const near = new Map<number, { n: number; gap: number }>()
    for (const a of acts) {
      const gap = Math.abs(Number(a.send_time) - sec)
      if (gap > 7200) continue
      const o = near.get(Number(a.sys_user_id)) || { n: 0, gap: Infinity }
      near.set(Number(a.sys_user_id), { n: o.n + 1, gap: Math.min(o.gap, gap) })
    }
    const best = [...near.entries()].sort((x, y) => y[1].n - x[1].n || x[1].gap - y[1].gap)[0]
    return best ? { sysUserId: best[0], how: 'active' } : null
  }
}

export interface EffIssue {
  /** 处理人（企微 user_id）；没人接手是 '' */
  handler: string
  /** 没人接手、归当班负责人（SaleSmartly 成员 ID）；0 = 没有 */
  dutySysUserId: number
  /** roster = 按值班表；active = 按当时在群里回复最多的人 */
  dutyHow: '' | 'roster' | 'active'
  status: string
  /** 晾着客户主管改成了不扣 */
  ignoredOff: boolean
  /** 1 简单 / 2 一般 / 3 疑难：AI 判的，主管改过的优先 */
  difficulty: number
  difficultyAi: number
  difficultyMarked: boolean
  /** 交接前的处理人（企微 user_id）、交接情况 full / part / none */
  handedFrom: string
  handover: string
  upstream: boolean
}

const has = (v: unknown): boolean => v !== null && v !== undefined

/** 主管改过的优先，其次 AI 的；AI 没判出处理人、主管也没改的，归当班负责人 */
export function effective(r: IssueMarkFields, duty: DutyFn): EffIssue {
  const handler = has(r.override_handler) ? String(r.override_handler) : r.handler_user_id
  const d = !has(r.override_handler) && !r.handler_user_id ? duty(Number(r.first_customer_at)) : null
  const ai = Number(r.difficulty_ai) || 1
  const handedFrom = handler ? (has(r.override_handed_from) ? String(r.override_handed_from) : r.handed_from || '') : ''
  const hoRaw = has(r.override_handover) ? String(r.override_handover) : r.handover || ''
  return {
    handler,
    dutySysUserId: d?.sysUserId || 0,
    dutyHow: d?.how || '',
    status: r.override_status || r.status,
    ignoredOff: has(r.override_ignored) && !Number(r.override_ignored),
    difficulty: has(r.difficulty) ? Number(r.difficulty) : ai,
    difficultyAi: ai,
    difficultyMarked: has(r.difficulty),
    handedFrom: handedFrom && handedFrom !== handler ? handedFrom : '',
    handover: handedFrom && handedFrom !== handler ? (['full', 'part', 'none'].includes(hoRaw) ? hoRaw : 'none') : '',
    upstream: has(r.override_upstream) ? !!Number(r.override_upstream) : !!Number(r.upstream)
  }
}

/** 查群问题时连上主管修改要带的列（表别名 i = wg_issues，k = wg_issue_marks） */
export const MARK_COLS = `i.handed_from, i.handover, i.upstream, i.difficulty_ai, k.override_handler, k.override_status, k.difficulty,
  k.override_handed_from, k.override_handover, k.override_upstream, k.override_ignored`

export interface IssueMsg { msg_id: string; sender_id: string; is_staff: number; is_self: number; at_list: unknown; content: string; send_time: number }
export interface IssueMetrics {
  firstCustomerAt: number; firstSec: number | null; avgSec: number | null; resolveSec: number | null; syncGapSec: number | null
  start: number; end: number; customerCnt: number; staffCnt: number
  /** 晾着客户：客户说话后超过 1 小时（不到 2 小时）/ 超过 2 小时没有任何员工回应的次数（值班按全天有人算） */
  ignored1h: number; ignored2h: number
  /** 明细（评分明细里显示）：首响从被 @ 派单还是客户提问算起、算了几轮、每次晾着客户（客户说话的时间、等了多久） */
  firstFrom: '' | 'called' | 'asked'; rounds: number; ignoredWaits: Array<{ at: number; sec: number }>
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
/** 需要回复的话（晾着客户从这种话算起）：问句、请求、报错；收尾的话（「好的谢谢」「还能接受」「我们再观察下」）不算 */
const NEED_RE = /[？?]|吗|嘛|呢[。.!！~～]*$|怎么|为什么|为啥|能不能|可不可以|是不是|有没有|多少|哪个|哪里|哪些|啥|什么|咋|帮忙|麻烦|帮我|看下|看一下|查下|查一下|处理一下|加一下|报错|错误|失败|不行|用不了|不能用|超时|异常|崩了|error|timeout|(4\d\d|5\d\d)/i
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
  // 晾着客户：从客户第一句没人回的话算起，到任何员工回应（只 @ 同事的派单不算回应）
  let waitStart = 0
  let ignored1h = 0
  let ignored2h = 0
  const ignoredWaits: Array<{ at: number; sec: number }> = []
  const ignoredWait = (w: number): void => {
    if (w > 7200) ignored2h++
    else if (w > 3600) ignored1h++
    if (w > 3600) ignoredWaits.push({ at: waitStart, sec: w })
  }
  let firstFrom: '' | 'called' | 'asked' = ''
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
      // 晾着客户：只从需要回复的话（问句、请求、报错，或者 @ 了员工）算起；转发的「[系统]」消息不算
      const needs = !isAck(m) && !(m.content || '').startsWith('[系统]') && (NEED_RE.test(m.content || '') || ats.some((id) => staffIds.has(id)))
      if (needs && !waitStart) waitStart = at
      continue
    }
    // 我方任何人说了话（包括商务回一句「让同事看下」）都算有回应
    if (waitStart) { ignoredWait(at - waitStart); waitStart = 0 }
    if (handler && m.sender_id === handler) {
      if (dispatchOnly(m)) continue
      if (!firstReplyAt) {
        firstReplyAt = at
        const from = calledAt || (pending.length ? roundStart(pending) : 0)
        firstFrom = calledAt ? 'called' : from ? 'asked' : ''
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

  // 最后一句一直没人回：算到现在
  if (waitStart) ignoredWait(Math.floor(Date.now() / 1000) - waitStart)
  let resolveSec: number | null = null
  let syncGapSec: number | null = null
  // 解决时间：AI 标出的解决那条；主管把状态改成「已解决」、AI 没标的，按处理人最后一次回复算（考核标准：到给出解决方案为止）
  const lastReply = handler ? [...sorted].reverse().find((m) => m.sender_id === handler && !dispatchOnly(m) && isProgress(m)) : undefined
  const solvedAt = Number(resolvedAt) || (lastReply ? Number(lastReply.send_time) : 0)
  if (status === 'resolved' && solvedAt && firstReplyAt) {
    const endAt = Math.max(solvedAt, firstReplyAt)
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
    staffCnt: sorted.filter((m) => m.is_staff && !m.is_self).length,
    ignored1h,
    ignored2h,
    firstFrom,
    rounds: waits.length,
    ignoredWaits
  }
}

export async function metricsCtx(): Promise<MetricsCtx> {
  return { staffIds: new Set((await query<{ user_id: string }>('SELECT user_id FROM wg_staff')).map((r) => r.user_id)) }
}

async function refresh(dept: Department): Promise<{ upserted: number; removed: number }> {
  const projectId = await deptProjectId(dept)
  if (!dept.groupChat || !projectId) return { upserted: 0, removed: 0 }
  const issues = await query<Row>(
    `SELECT i.id, i.room_id, i.room_name, i.day, i.anchor_msg_id, i.summary, i.message_ids, i.handler_user_id, i.status, i.first_customer_at,
            i.resolved_at, ${MARK_COLS}
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
  const deptMembers = new Set((await query<{ sys_user_id: number }>('SELECT sys_user_id FROM members WHERE project_id = ? AND department_id = ?', [projectId, dept.id])).map((m) => Number(m.sys_user_id)))
  const ctx = await metricsCtx()
  const gc = await getGroupConfig(dept)
  const duty = await dutyResolver(dept, gc)
  // 最近两天的问题，「晾着客户」可能还在变（最后一句一直没人回，算到现在），每小时重算一次
  const hour = Math.floor(now() / 3600)
  const recentDay = new Date((now() - 86400) * 1000)
  const recent = `${recentDay.getFullYear()}-${String(recentDay.getMonth() + 1).padStart(2, '0')}-${String(recentDay.getDate()).padStart(2, '0')}`

  const want = new Map<string, { r: Row; e: EffIssue; sysUserId: number; handedFromSys: number; msgIds: string[]; sig: string }>()
  for (const r of issues) {
    const e = effective(r, duty)
    // 处理人是本部门成员的挂到他名下；没人接手的挂到当班负责人名下
    const sysUserId = e.handler ? memberOf.get(e.handler) || 0 : deptMembers.has(e.dutySysUserId) ? e.dutySysUserId : 0
    if (!sysUserId) continue
    const handedFromSys = e.handedFrom ? memberOf.get(e.handedFrom) || 0 : 0
    const msgIds = json<string[]>(r.message_ids, [])
    const sig = sha(JSON.stringify(['m8', r.day >= recent ? hour : 0, r.id, e, sysUserId, handedFromSys, r.summary, r.room_name, msgIds, Number(r.first_customer_at), Number(r.resolved_at)]))
    want.set(issueSessionId(dept.id, r.room_id, r.anchor_msg_id), { r, e, sysUserId, handedFromSys: handedFromSys === sysUserId ? 0 : handedFromSys, msgIds, sig })
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
      const x = issueMetrics(ms, w.e.handler, ctx, w.e.status, Number(w.r.resolved_at))
      const first = x.firstCustomerAt || Number(w.r.first_customer_at) || 0
      return [projectId, id, 'wg', w.r.room_id.slice(0, 128), w.sig, w.r.id, w.e.status, (w.r.summary || '').slice(0, 255),
        x.firstSec, x.avgSec, x.resolveSec, x.syncGapSec, w.e.difficulty, w.handedFromSys, w.handedFromSys ? w.e.handover : '', w.e.upstream ? 1 : 0, w.e.handler ? 0 : 1,
        w.e.ignoredOff ? 0 : x.ignored1h, w.e.ignoredOff ? 0 : x.ignored2h, '',
        (w.r.room_name || w.r.room_id).slice(0, 255), w.sysUserId, WG_CHANNEL, 0, x.start || first, x.end || first, first || x.start, 0, 0, '',
        ms.length, x.customerCnt, x.staffCnt, 1, 0, t]
    })
    for (let i = 0; i < values.length; i += 300) {
      await execute(
        `INSERT INTO ss_sessions (project_id, session_id, source, room_id, content_sig, issue_id, issue_status, issue_summary,
           issue_first_sec, issue_avg_sec, issue_resolve_sec, issue_sync_gap_sec, issue_difficulty, issue_handed_from_sys, issue_handover, issue_upstream, issue_duty, issue_ignored1h, issue_ignored2h, chat_user_id,
           customer_name, sys_user_id, channel, channel_id, start_time, end_time, assign_time, star_score, quality_score, tags,
           msg_count, user_msg_count, kf_msg_count, msgs_synced, msg_fail, synced_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE content_sig = VALUES(content_sig), issue_id = VALUES(issue_id), issue_status = VALUES(issue_status),
           issue_summary = VALUES(issue_summary), issue_first_sec = VALUES(issue_first_sec), issue_avg_sec = VALUES(issue_avg_sec),
           issue_resolve_sec = VALUES(issue_resolve_sec), issue_sync_gap_sec = VALUES(issue_sync_gap_sec), issue_difficulty = VALUES(issue_difficulty),
           issue_handed_from_sys = VALUES(issue_handed_from_sys), issue_handover = VALUES(issue_handover), issue_upstream = VALUES(issue_upstream), issue_duty = VALUES(issue_duty),
           issue_ignored1h = VALUES(issue_ignored1h), issue_ignored2h = VALUES(issue_ignored2h),
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
