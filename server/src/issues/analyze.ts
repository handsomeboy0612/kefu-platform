/**
 * 对公群 AI 分问题（方案见 docs/ai-issue-plan.md）。
 *
 * 处理单位：一个群一天（北京时间），只处理当天客户和员工都说过话的群。
 * 当天也分析：一个群聊天停下超过切段间隔（默认 30 分钟）才分析，之后又有新消息、再停下来就重新分析；正在聊的先不动。
 * AI 判断：哪些消息是同一个问题、谁实际处理、解决没有（引用原话）。程序负责：校验、算时间、谁算数。
 * 稳定：一个群一天的输入（这天的消息 + 之前各天的结果 + 提示词版本 + 模型）没变就不重调 AI；
 *       某天要重跑时，先把这天及以后各天的改动按倒序撤回，再从这天往后重放（输入没变的直接用缓存结果）。
 * 失败（AI 报错、校验两次不过）：这个群当天没有 AI 结果（不算分），不影响同步；同样的输入失败 3 次后不再自动重试，可以在「群问题」里重新分析。
 */
import { createHash } from 'crypto'
import { execute, now, query, transaction } from '../db'
import { listDepartments, type Department } from '../auth'
import { getDeptSetting, isSectionConfigured, type AISettings } from '../settings'
import { AIConfigError, callAI, RetryableError } from '../ai/score'
import { ISSUE_PROMPT, PROMPT_VERSION } from './prompt'
import { fetchGroups } from '../services/archive'
import { getGroupConfig, roomCounted } from '../group/config'
import { refreshIssueSessions } from './sessions'

const CARRY_DAYS = 3
const ROOM_CONCURRENCY = 3

interface Msg {
  msg_id: string
  room_id: string
  sender_id: string
  sender_name: string
  is_staff: number
  is_self: number
  content: string
  at_list: unknown
  refer_id: string
  send_time: number
}

interface IssueRow {
  id: number
  department_id: number
  room_id: string
  room_name: string
  day: string
  updated_day: string
  anchor_msg_id: string
  summary: string
  customer_ids: unknown
  message_ids: unknown
  handler_user_id: string
  handler_reason: string | null
  helper_ids: unknown
  status: string
  resolved_msg_id: string
  evidence: string | null
  first_customer_at: number
  first_reply_at: number
  resolved_at: number
  created_at: number
  handed_from?: string
  handover?: string
  upstream?: number
  difficulty_ai?: number
  feedback?: unknown
}

export interface AiIssue {
  ref: string
  summary: string
  customer_ids: string[]
  message_ids: string[]
  handler_id: string
  handler_reason: string
  helper_ids: string[]
  status: 'resolved' | 'unresolved' | 'unknown'
  resolved_msg_id: string
  evidence: string
  /** 交接前的处理人（企微 user_id），没有交接是 '' */
  handed_from_id: string
  /** full 交接完整 / part 不完整 / none 没交接；没有交接是 '' */
  handover: '' | 'full' | 'part' | 'none'
  /** 要靠上游 / 官方 / 研发才能解决 */
  upstream: boolean
  difficulty: 'simple' | 'normal' | 'hard'
  feedback: AiFeedback[]
}

/** AI 标出的客户反馈（主管确认后计入第二项满意度） */
export interface AiFeedback { type: 'complaint' | 'mild' | 'praise'; msg_id: string; target_id: string; own_fault: boolean; reason: string }
/** 存进 wg_issues.feedback 的：再带上消息时间和原话 */
export interface StoredFeedback extends AiFeedback { at: number; quote: string }

const DIFF: Record<string, number> = { simple: 1, normal: 2, hard: 3 }
/** 只是派单 / 催一下的话（「跟进一下」「看下」），说这种话的人不算处理过 */
const DISPATCH_RE = /^(@\S*)*(跟进|跟进一下|跟进下|看下|看一下|看看|帮忙看下|帮忙看一下|处理一下|处理下|帮忙处理下|收到|好的|ok|稍等)*[。.!！~～]*$/i
/** 交接人得实际处理过：在这个问题的消息（含前几天的）里对客户说过实质的话；只 @ 同事派单、只说「跟进一下」的不算 */
export const handledBy = (msgs: Msg[], who: string, staffIds: Set<string>): boolean =>
  !!who && msgs.some((m) => m.sender_id === who && !dispatchOnly(m, staffIds) && !DISPATCH_RE.test(norm(m.content)))
const dispatchOnly = (m: Msg, staffIds: Set<string>): boolean => {
  const ats = json<Array<{ user_id: string }>>(m.at_list, []).map((a) => a.user_id).filter(Boolean)
  return ats.length > 0 && ats.every((id) => staffIds.has(id))
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const dayOf = (sec: number): string => {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const dayStart = (day: string): number => Math.floor(new Date(`${day}T00:00:00+08:00`).getTime() / 1000)
const addDays = (day: string, n: number): string => dayOf(dayStart(day) + n * 86400 + 3600)
const hm = (sec: number): string => { const d = new Date(sec * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const sha = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0001')).digest('hex')
const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T))
const isCustomer = (m: Msg): boolean => !m.is_staff && !m.is_self
const norm = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase()

async function dayMessages(roomId: string, day: string): Promise<Msg[]> {
  const b = dayStart(day)
  return query<Msg>(
    'SELECT msg_id, room_id, sender_id, sender_name, is_staff, is_self, content, at_list, refer_id, send_time FROM wg_messages WHERE room_id = ? AND send_time >= ? AND send_time < ? ORDER BY send_time, msg_id',
    [roomId, b, b + 86400]
  )
}

async function messagesByIds(ids: string[]): Promise<Msg[]> {
  if (!ids.length) return []
  return query<Msg>(
    'SELECT msg_id, room_id, sender_id, sender_name, is_staff, is_self, content, at_list, refer_id, send_time FROM wg_messages WHERE msg_id IN (?) ORDER BY send_time, msg_id',
    [ids]
  )
}

/** 带进来的旧问题：近 3 天未解决 / 判断不了的，加上 24 小时内刚判为已解决的 */
async function carriedIssues(deptId: number, roomId: string, day: string): Promise<IssueRow[]> {
  const from = addDays(day, -CARRY_DAYS)
  const rows = await query<IssueRow>(
    'SELECT * FROM wg_issues WHERE department_id = ? AND room_id = ? AND day >= ? AND day < ? ORDER BY day, id',
    [deptId, roomId, from, day]
  )
  const since = dayStart(day) - 86400
  return rows.filter((r) => r.status !== 'resolved' || Number(r.resolved_at) >= since)
}

const staffName = (m: Msg, nicks: Map<string, string>): string => nicks.get(m.sender_id) || m.sender_name || m.sender_id

function line(m: Msg, nicks: Map<string, string>): string {
  const who = m.is_self ? '机器人' : m.is_staff ? `员工·${staffName(m, nicks)}` : `客户·${m.sender_name || m.sender_id}`
  const ats = json<Array<{ user_id: string; nickname: string }>>(m.at_list, []).filter((a) => a.user_id)
  const atText = ats.length ? ` @${ats.map((a) => nicks.get(a.user_id) || a.nickname || a.user_id).join(' @')}` : ''
  const refer = m.refer_id ? ` ↪引用 m:${m.refer_id}` : ''
  return `[m:${m.msg_id}] ${hm(m.send_time)} ${who}${atText}${refer}：${(m.content || '').replace(/\s+/g, ' ').slice(0, 800)}`
}

interface Built {
  text: string
  msgs: Msg[]
  carried: IssueRow[]
  staffIds: Set<string>
  msgHash: string
}

async function buildInput(deptId: number, roomId: string, roomName: string, day: string, msgs: Msg[]): Promise<Built> {
  const carried = await carriedIssues(deptId, roomId, day)
  const staffRows = await query<{ user_id: string; nickname: string }>('SELECT user_id, nickname FROM wg_staff')
  const nicks = new Map(staffRows.map((s) => [s.user_id, s.nickname]))
  const staffIds = new Set<string>()
  for (const m of msgs) {
    if (m.is_staff && !m.is_self && m.sender_id) staffIds.add(m.sender_id)
    for (const a of json<Array<{ user_id: string }>>(m.at_list, [])) if (a.user_id && nicks.has(a.user_id)) staffIds.add(a.user_id)
  }
  const oldParts: string[] = []
  for (const c of carried) {
    const last = (await messagesByIds(json<string[]>(c.message_ids, []))).slice(-5)
    for (const m of last) if (m.is_staff && m.sender_id) staffIds.add(m.sender_id)
    if (c.handler_user_id) staffIds.add(c.handler_user_id)
    const who = c.handler_user_id ? `${nicks.get(c.handler_user_id) || c.handler_user_id}（ID: ${c.handler_user_id}）` : '没人处理'
    oldParts.push(`### 旧问题 #${c.id}（${c.day} 开始，现在${c.status === 'resolved' ? '已解决' : c.status === 'unresolved' ? '未解决' : '判断不了'}，处理人：${who}）：${c.summary}\n${last.map((m) => line(m, nicks)).join('\n')}`)
  }
  const staffList = [...staffIds].map((id) => `- ${nicks.get(id) || id}（ID: ${id}）`).join('\n')
  const text = [
    `## 群：${roomName || roomId}`,
    `## 日期：${day}（北京时间）`,
    `## 这个群的员工（我方人员，handler_id / helper_ids 只能从这里选）\n${staffList || '（无）'}`,
    carried.length ? `## 往前带的旧问题（今天的消息如果是接着问 / 复发，ref 填旧问题编号）\n${oldParts.join('\n\n')}` : '## 往前带的旧问题：无',
    `## 今天的消息（只能用这里的消息编号）\n${msgs.map((m) => line(m, nicks)).join('\n')}`
  ].join('\n\n')
  const msgHash = sha(msgs.map((m) => `${m.msg_id}|${m.send_time}|${m.sender_id}|${m.content}`).join('\n'), staffList)
  return { text, msgs, carried, staffIds, msgHash }
}

/** 校验 AI 输出（方案第 5 节），返回问题列表或错误说明 */
function validate(raw: unknown, b: Built): { issues: AiIssue[] } | { error: string } {
  const o = raw as { issues?: unknown; other_message_ids?: unknown }
  if (!o || !Array.isArray(o.issues)) return { error: '没有 issues 数组' }
  const byId = new Map(b.msgs.map((m) => [m.msg_id, m]))
  const oldIds = new Set(b.carried.map((c) => String(c.id)))
  const used = new Set<string>()
  const out: AiIssue[] = []
  for (const [i, x] of (o.issues as Array<Record<string, unknown>>).entries()) {
    const tag = `第 ${i + 1} 个问题`
    const clean = (v: unknown): string => String(v ?? '').trim().replace(/^m:/i, '')
    const ids: string[] = (Array.isArray(x.message_ids) ? x.message_ids : []).map(clean)
    const ref = String(x.ref ?? 'new').trim().replace(/^#/, '') || 'new'
    // 一条消息都没有的问题没有意义，跳过（AI 偶尔会多输出一个空问题）
    if (!ids.length) continue
    for (const id of ids) if (!byId.has(id)) return { error: `${tag} 的消息编号 ${id} 不是今天这个群的消息` }
    // 同一条消息被分到了好几个问题：只留在第一个问题里（不编造任何东西，只是去重）；去完没消息了就跳过这个问题
    const dup = ids.filter((id) => used.has(id))
    if (dup.length) ids.splice(0, ids.length, ...ids.filter((id) => !used.has(id)))
    if (!ids.length) continue
    for (const id of ids) used.add(id)
    if (ref !== 'new' && !oldIds.has(ref)) return { error: `${tag} 接回的旧问题编号 ${ref} 不存在` }
    const status = String(x.status)
    if (!['resolved', 'unresolved', 'unknown'].includes(status)) return { error: `${tag} 的状态 ${status} 不对` }
    const msgs = ids.map((id) => byId.get(id)!)
    // 处理人得是员工，并且在这个问题里说过话、被 @ 过，或者是接回的旧问题；对不上就当 AI 没判出处理人（不让整个群这一天都失败）
    let handler = String(x.handler_id || '')
    if (handler) {
      const spoke = msgs.some((m) => m.sender_id === handler)
      const atted = msgs.some((m) => json<Array<{ user_id: string }>>(m.at_list, []).some((a) => a.user_id === handler))
      const inOld = ref !== 'new'
      if (!b.staffIds.has(handler) || (!spoke && !atted && !inOld)) handler = ''
    }
    const resolvedId = clean(x.resolved_msg_id)
    if (status === 'resolved') {
      if (!resolvedId || !ids.includes(resolvedId)) return { error: `${tag} 判为已解决，但解决消息 ${resolvedId || '（空）'} 不在这个问题的消息里` }
    }
    const evidence = String(x.evidence || '').trim()
    if (status !== 'unknown') {
      if (!evidence) return { error: `${tag} 没有给依据原话` }
      const ne = norm(evidence)
      if (!msgs.some((m) => norm(m.content).includes(ne))) return { error: `${tag} 的依据原话「${evidence.slice(0, 30)}」在消息里找不到` }
    }
    // 交接：前一处理人得是员工、和处理人不同；交接情况不对按「没交接」
    let handedFrom = handler ? String(x.handed_from_id || '').trim() : ''
    if (handedFrom && (handedFrom === handler || !b.staffIds.has(handedFrom))) handedFrom = ''
    if (handedFrom) {
      const oldHandler = ref !== 'new' ? b.carried.find((c) => String(c.id) === ref)?.handler_user_id : ''
      const handled = handedFrom === oldHandler || msgs.some((m) => m.sender_id === handedFrom && !dispatchOnly(m, b.staffIds) && !DISPATCH_RE.test(norm(m.content)))
      if (!handled) handedFrom = ''
    }
    const ho = String(x.handover || '').trim()
    const handover = (handedFrom ? (['full', 'part', 'none'].includes(ho) ? ho : 'none') : '') as AiIssue['handover']
    const diff = String(x.difficulty || '').trim()
    // 客户反馈：只留这个问题里客户发的消息；针对的人不是员工就按处理人
    const fb: AiFeedback[] = []
    for (const f of Array.isArray(x.feedback) ? (x.feedback as Array<Record<string, unknown>>) : []) {
      const mid = clean(f?.msg_id)
      const type = String(f?.type || '').trim()
      const m = byId.get(mid)
      if (!m || !ids.includes(mid) || !isCustomer(m) || !['complaint', 'mild', 'praise'].includes(type) || fb.some((y) => y.msg_id === mid)) continue
      const target = String(f?.target_id || '').trim()
      fb.push({
        type: type as AiFeedback['type'], msg_id: mid, target_id: b.staffIds.has(target) ? target : handler,
        own_fault: type === 'praise' ? true : f?.own_fault === true || f?.own_fault === 'true', reason: String(f?.reason || '').slice(0, 200)
      })
    }
    out.push({
      ref,
      summary: String(x.summary || '').slice(0, 500),
      customer_ids: (Array.isArray(x.customer_ids) ? x.customer_ids : []).map(String),
      message_ids: ids,
      handler_id: handler,
      handler_reason: String(x.handler_reason || '').slice(0, 500),
      helper_ids: (Array.isArray(x.helper_ids) ? x.helper_ids : []).map(String).filter((h) => b.staffIds.has(h) && h !== handler),
      status: status as AiIssue['status'],
      resolved_msg_id: status === 'resolved' ? resolvedId : '',
      evidence,
      handed_from_id: handedFrom,
      handover,
      upstream: x.upstream === true || x.upstream === 'true',
      difficulty: (['simple', 'normal', 'hard'].includes(diff) ? diff : 'simple') as AiIssue['difficulty'],
      feedback: fb
    })
  }
  return { issues: out }
}

/** 调 AI + 校验；校验不过带着错误重试一次 */
async function analyze(ai: AISettings, b: Built): Promise<{ issues: AiIssue[]; model: string; tokensIn: number; tokensOut: number }> {
  let feedback = ''
  let tokensIn = 0
  let tokensOut = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = feedback ? `${b.text}\n\n## 上一次的输出没通过检查：${feedback}\n请改正后重新输出完整 JSON。` : b.text
    let r
    for (let net = 0; ; net++) {
      try {
        r = await callAI(ai, {
          model: ai.model,
          messages: [{ role: 'system', content: ISSUE_PROMPT }, { role: 'user', content: user }],
          temperature: 0,
          response_format: { type: 'json_object' }
        })
        break
      } catch (err) {
        if (!(err instanceof RetryableError) || net >= 2) throw err
        await new Promise((res) => setTimeout(res, 3000 * (net + 1)))
      }
    }
    tokensIn += r.tokensIn
    tokensOut += r.tokensOut
    let parsed: unknown
    try {
      parsed = JSON.parse(r.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''))
    } catch {
      feedback = '输出不是合法 JSON'
      continue
    }
    const v = validate(parsed, b)
    if ('issues' in v) return { issues: v.issues, model: r.model, tokensIn, tokensOut }
    feedback = v.error
  }
  throw new Error(`AI 输出两次都没通过检查：${feedback}`)
}

/** 算问题的时间：客户第一条、处理人第一次回应（含「稍等」，只 @ 同事的派单不算）、解决消息时间 */
function timesOf(msgs: Msg[], handler: string, resolvedId: string, staffIds: Set<string>): { first_customer_at: number; first_reply_at: number; resolved_at: number } {
  const sorted = [...msgs].sort((a, b) => a.send_time - b.send_time)
  const fc = sorted.find(isCustomer)
  const firstCustomerAt = fc ? Number(fc.send_time) : 0
  let firstReplyAt = 0
  if (handler && firstCustomerAt) {
    const r = sorted.find((m) => {
      if (m.sender_id !== handler || Number(m.send_time) < firstCustomerAt) return false
      const ats = json<Array<{ user_id: string }>>(m.at_list, []).map((a) => a.user_id).filter(Boolean)
      const dispatchOnly = ats.length > 0 && ats.every((id) => staffIds.has(id))
      return !dispatchOnly
    })
    firstReplyAt = r ? Number(r.send_time) : 0
  }
  const rm = resolvedId ? sorted.find((m) => m.msg_id === resolvedId) : undefined
  return { first_customer_at: firstCustomerAt, first_reply_at: firstReplyAt, resolved_at: rm ? Number(rm.send_time) : 0 }
}

/** 把一天的 AI 结果写进 wg_issues，返回新建的问题和改之前的旧问题（回滚用） */
async function applyDay(dept: Department, roomId: string, roomName: string, day: string, issues: AiIssue[], b: Built): Promise<{ created: number[]; prev: IssueRow[] }> {
  const created: number[] = []
  const prev: IssueRow[] = []
  const byId = new Map(b.msgs.map((m) => [m.msg_id, m]))
  // 客户反馈带上消息时间和原话存起来（主管确认、绩效按时间段统计用）
  const stored = (fb: AiFeedback[] | undefined): StoredFeedback[] => (fb || []).map((f) => {
    const m = byId.get(f.msg_id)
    return { ...f, at: m ? Number(m.send_time) : 0, quote: (m?.content || '').slice(0, 300) }
  })
  for (const x of issues) {
    const own = x.message_ids.map((id) => byId.get(id)!).filter(Boolean)
    if (x.ref === 'new') {
      const t = timesOf(own, x.handler_id, x.resolved_msg_id, b.staffIds)
      if (x.handed_from_id && !handledBy(own, x.handed_from_id, b.staffIds)) { x.handed_from_id = ''; x.handover = '' }
      const anchor = [...own].sort((a, b2) => a.send_time - b2.send_time)[0].msg_id
      const res = await execute(
        `INSERT INTO wg_issues (department_id, room_id, room_name, day, updated_day, anchor_msg_id, summary, customer_ids, message_ids,
           handler_user_id, handler_reason, helper_ids, handed_from, handover, upstream, difficulty_ai, status, resolved_msg_id, evidence, feedback,
           first_customer_at, first_reply_at, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
        [dept.id, roomId, roomName.slice(0, 255), day, day, anchor, x.summary, JSON.stringify(x.customer_ids), JSON.stringify(x.message_ids),
          x.handler_id, x.handler_reason, JSON.stringify(x.helper_ids), x.handed_from_id || '', x.handover || '', x.upstream ? 1 : 0, DIFF[x.difficulty] || 1,
          x.status, x.resolved_msg_id, x.evidence, JSON.stringify(stored(x.feedback)),
          t.first_customer_at, t.first_reply_at, t.resolved_at, now()]
      )
      created.push(res.insertId)
    } else {
      const [old] = await query<IssueRow>('SELECT * FROM wg_issues WHERE id = ?', [Number(x.ref)])
      if (!old) continue
      if (!prev.some((p) => p.id === old.id)) prev.push(old)
      const ids = [...new Set([...json<string[]>(old.message_ids, []), ...x.message_ids])]
      const all = await messagesByIds(ids)
      const handler = x.handler_id || old.handler_user_id
      const t = timesOf(all, handler, x.resolved_msg_id, b.staffIds)
      // 交接：今天判出了交接就用今天的；处理人没换就沿用以前的；换了人但 AI 说不算交接，就没有交接
      const sameHandler = handler === old.handler_user_id
      let handedFrom = x.handed_from_id || (sameHandler ? old.handed_from || '' : '')
      let handover = x.handed_from_id ? x.handover : sameHandler ? old.handover || '' : ''
      if (handedFrom && !handledBy(all, handedFrom, b.staffIds)) { handedFrom = ''; handover = '' }
      // 客户反馈：以前的加上今天的（同一条消息只留一次）
      const oldFb = json<StoredFeedback[]>(old.feedback, [])
      const fb = [...oldFb, ...stored(x.feedback).filter((f) => !oldFb.some((o) => o.msg_id === f.msg_id))]
      await execute(
        `UPDATE wg_issues SET updated_day = ?, summary = ?, customer_ids = CAST(? AS JSON), message_ids = CAST(? AS JSON), handler_user_id = ?,
           handler_reason = ?, helper_ids = CAST(? AS JSON), handed_from = ?, handover = ?, upstream = ?, difficulty_ai = ?,
           status = ?, resolved_msg_id = ?, evidence = ?, feedback = CAST(? AS JSON), first_customer_at = ?, first_reply_at = ?, resolved_at = ?
         WHERE id = ?`,
        [day, x.summary || old.summary, JSON.stringify([...new Set([...json<string[]>(old.customer_ids, []), ...x.customer_ids])]), JSON.stringify(ids),
          handler, x.handler_reason || old.handler_reason, JSON.stringify(x.helper_ids), handedFrom, handover,
          x.upstream || Number(old.upstream) ? 1 : 0, Math.max(DIFF[x.difficulty] || 1, Number(old.difficulty_ai) || 1),
          x.status, x.resolved_msg_id, x.evidence || old.evidence, JSON.stringify(fb),
          t.first_customer_at, t.first_reply_at, t.resolved_at, old.id]
      )
    }
  }
  return { created, prev }
}

/** 撤回某群从 day 起（含）所有已应用的分析结果，倒序撤 */
async function rollbackFrom(deptId: number, roomId: string, day: string): Promise<void> {
  const runs = await query<{ day: string; created_issue_ids: unknown; prev_states: unknown }>(
    'SELECT day, created_issue_ids, prev_states FROM wg_issue_runs WHERE department_id = ? AND room_id = ? AND day >= ? AND applied = 1 ORDER BY day DESC',
    [deptId, roomId, day]
  )
  for (const r of runs) {
    await transaction(async (conn) => {
      const created = json<number[]>(r.created_issue_ids, [])
      if (created.length) await conn.query('DELETE FROM wg_issues WHERE id IN (?)', [created])
      for (const p of json<IssueRow[]>(r.prev_states, [])) {
        await conn.query(
          `UPDATE wg_issues SET updated_day = ?, summary = ?, customer_ids = CAST(? AS JSON), message_ids = CAST(? AS JSON), handler_user_id = ?,
             handler_reason = ?, helper_ids = CAST(? AS JSON), handed_from = ?, handover = ?, upstream = ?, difficulty_ai = ?,
             status = ?, resolved_msg_id = ?, evidence = ?, feedback = CAST(? AS JSON), first_customer_at = ?, first_reply_at = ?, resolved_at = ?
           WHERE id = ?`,
          [p.updated_day, p.summary, JSON.stringify(json(p.customer_ids, [])), JSON.stringify(json(p.message_ids, [])), p.handler_user_id,
            p.handler_reason, JSON.stringify(json(p.helper_ids, [])), p.handed_from || '', p.handover || '', Number(p.upstream) || 0, Number(p.difficulty_ai) || 1,
            p.status, p.resolved_msg_id, p.evidence, JSON.stringify(json(p.feedback, [])), p.first_customer_at, p.first_reply_at, p.resolved_at, p.id]
        )
      }
      await conn.query('UPDATE wg_issue_runs SET applied = 0 WHERE department_id = ? AND room_id = ? AND day = ?', [deptId, roomId, r.day])
    })
  }
}

export interface AnalyzeProgress { from: string; to: string; rooms: number; roomsDone: number; calls: number; failed: number; startedAt: number; by: string }
const running = new Map<string, AnalyzeProgress>()
export const analyzeProgress = (deptCode: string): AnalyzeProgress | null => running.get(deptCode) ?? null

/** 分析一个群从 from 到 to 的每一天（按天顺序，带缓存和回滚） */
async function analyzeRoom(dept: Department, ai: AISettings, roomId: string, roomName: string, from: string, to: string, forceRange: boolean, quietSec: number, p: AnalyzeProgress): Promise<void> {
  // 改了某天，后面各天都会被撤回，所以不管选到哪天，都一直重放到今天（输入没变的直接用缓存，不调 AI）；force 只对选的那段
  const today = dayOf(now())
  const [before] = await query<{ chain_hash: string; out_hash: string }>(
    'SELECT chain_hash, out_hash FROM wg_issue_runs WHERE department_id = ? AND room_id = ? AND day < ? AND applied = 1 ORDER BY day DESC LIMIT 1',
    [dept.id, roomId, from]
  )
  let prevChain = before?.chain_hash || ''
  let prevOut = before?.out_hash || ''
  if (forceRange) await rollbackFrom(dept.id, roomId, from)
  for (let day = from; day <= today; day = addDays(day, 1)) {
    const force = forceRange && day <= to
    const msgs = await dayMessages(roomId, day)
    const [run] = await query<{ chain_hash: string; out_hash: string; status: string; output: unknown; applied: number; attempts: number }>(
      'SELECT chain_hash, out_hash, status, output, applied, attempts FROM wg_issue_runs WHERE department_id = ? AND room_id = ? AND day = ?',
      [dept.id, roomId, day]
    )
    // 还在聊（最后一条离现在不到切段间隔）：这天先不分析，后面的天也不动（按天顺序），等聊完再说
    const lastAt = msgs.length ? Number(msgs[msgs.length - 1].send_time) : 0
    if (lastAt && now() - lastAt < quietSec) break
    const hasCustomer = msgs.some(isCustomer)
    const hasStaff = msgs.some((m) => m.is_staff && !m.is_self)
    if (!hasCustomer || !hasStaff) {
      if (run) {
        await rollbackFrom(dept.id, roomId, day)
        await execute('DELETE FROM wg_issue_runs WHERE department_id = ? AND room_id = ? AND day = ?', [dept.id, roomId, day])
      }
      continue
    }
    // 先按「消息 + 之前的链」算这一天的输入指纹，判断要不要动
    const msgSig = sha(msgs.map((m) => `${m.msg_id}|${m.send_time}|${m.content}`).join('\n'))
    const chain = sha(prevChain, prevOut, msgSig, PROMPT_VERSION, ai.model)
    if (!force && run && run.applied && run.chain_hash === chain) {
      prevChain = chain
      prevOut = run.out_hash
      continue
    }
    await rollbackFrom(dept.id, roomId, day)
    const b = await buildInput(dept.id, roomId, roomName, day, msgs)
    let issues: AiIssue[] | null = null
    let model = ai.model
    let tin = 0
    let tout = 0
    let error: string | null = null
    if (!force && run && run.chain_hash === chain && run.status === 'ok' && run.output) {
      issues = json<AiIssue[]>(run.output, [])
    } else if (!force && run && run.chain_hash === chain && run.status === 'failed' && run.attempts >= 3) {
      error = '同样的输入已经连续失败 3 次，不再自动重试（可以手动重新分析）'
    } else {
      try {
        p.calls++
        const r = await analyze(ai, b)
        issues = r.issues
        model = r.model
        tin = r.tokensIn
        tout = r.tokensOut
      } catch (err) {
        if (err instanceof AIConfigError) throw err
        error = (err as Error).message
      }
    }
    if (issues) {
      const { created, prev } = await applyDay(dept, roomId, roomName, day, issues, b)
      const outHash = sha(JSON.stringify(issues))
      await execute(
        `INSERT INTO wg_issue_runs (department_id, room_id, day, chain_hash, out_hash, status, error, output, applied, created_issue_ids, prev_states, model, tokens_in, tokens_out, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ok', NULL, CAST(? AS JSON), 1, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE chain_hash = VALUES(chain_hash), out_hash = VALUES(out_hash), status = 'ok', error = NULL, output = VALUES(output), applied = 1,
           created_issue_ids = VALUES(created_issue_ids), prev_states = VALUES(prev_states), model = VALUES(model),
           tokens_in = IF(VALUES(tokens_in) > 0, VALUES(tokens_in), tokens_in), tokens_out = IF(VALUES(tokens_out) > 0, VALUES(tokens_out), tokens_out),
           attempts = 1, updated_at = VALUES(updated_at)`,
        [dept.id, roomId, day, chain, outHash, JSON.stringify(issues), JSON.stringify(created), JSON.stringify(prev), model.slice(0, 64), tin, tout, now()]
      )
      prevChain = chain
      prevOut = outHash
    } else {
      p.failed++
      await execute(
        `INSERT INTO wg_issue_runs (department_id, room_id, day, chain_hash, out_hash, status, error, output, applied, model, attempts, updated_at)
         VALUES (?, ?, ?, ?, 'failed', 'failed', ?, NULL, 0, ?, 1, ?)
         ON DUPLICATE KEY UPDATE attempts = IF(chain_hash = VALUES(chain_hash), attempts + 1, 1), chain_hash = VALUES(chain_hash), out_hash = 'failed',
           status = 'failed', error = VALUES(error), output = NULL, applied = 0, updated_at = VALUES(updated_at)`,
        [dept.id, roomId, day, chain, (error || '').slice(0, 2000), ai.model.slice(0, 64), now()]
      )
      prevChain = chain
      prevOut = 'failed'
    }
  }
}

export class AnalyzeBusyError extends Error {}

/** 分析一个部门 [from, to] 的对公群（后台跑）；from / to 是 YYYY-MM-DD，to 不会超过昨天 */
export async function startAnalyze(dept: Department, from: string, to: string, by: string, force = false): Promise<AnalyzeProgress> {
  if (!dept.groupChat) throw new Error('本部门没有开对公群')
  if (running.has(dept.code)) throw new AnalyzeBusyError('正在分析，等这次跑完再试')
  const ai = await getDeptSetting(dept.code, 'ai')
  if (!isSectionConfigured('ai', ai)) throw new Error('本部门还没有配好 AI 接口')
  const today = dayOf(now())
  if (to > today) to = today
  if (from > to) throw new Error('日期不对（不能分析还没到的天）')
  const gc = await getGroupConfig(dept)
  const quietSec = gc.gapMin * 60
  // 选中的群：同步时存过消息的群（room_name 取群会话里的名字，没有就用 ID）
  const allRooms = await query<{ room_id: string }>(
    'SELECT DISTINCT room_id FROM wg_messages WHERE send_time >= ? AND send_time < ?', [dayStart(from) - CARRY_DAYS * 86400, dayStart(to) + 86400]
  )
  // 群名：从归档服务取；取不到就用群会话里存的名字
  const names = new Map((await query<{ room_id: string; name: string }>(
    "SELECT room_id, MAX(customer_name) name FROM ss_sessions WHERE source = 'wg' GROUP BY room_id"
  )).map((r) => [r.room_id, r.name]))
  try {
    for (const g of await fetchGroups(await getDeptSetting(dept.code, 'archive'))) if (g.room_name) names.set(g.room_id, g.room_name)
  } catch { /* 归档服务连不上就用已有的名字 */ }
  // 现在不算的群（改了群筛选、排除了渠道群等）：不分析，以前分析出的问题删掉（群名不知道的先留着）
  const notCounted = (id: string): boolean => names.has(id) && !roomCounted(gc, id, names.get(id) || '')
  const stale = (await query<{ room_id: string }>(
    'SELECT DISTINCT room_id FROM wg_issue_runs WHERE department_id = ? UNION SELECT DISTINCT room_id FROM wg_issues WHERE department_id = ?', [dept.id, dept.id]
  )).map((r) => r.room_id).filter(notCounted)
  for (let i = 0; i < stale.length; i += 200) {
    const ids = stale.slice(i, i + 200)
    await execute('DELETE FROM wg_issues WHERE department_id = ? AND room_id IN (?)', [dept.id, ids])
    await execute('DELETE FROM wg_issue_runs WHERE department_id = ? AND room_id IN (?)', [dept.id, ids])
  }
  if (stale.length) console.log(`[issues] ${dept.name} ${stale.length} 个群现在不算对公群，删掉了以前分析出的问题`)
  const rooms = allRooms.filter((r) => !notCounted(r.room_id))
  const p: AnalyzeProgress = { from, to, rooms: rooms.length, roomsDone: 0, calls: 0, failed: 0, startedAt: now(), by }
  running.set(dept.code, p)
  void (async () => {
    const queue = rooms.map((r) => r.room_id)
    try {
      await Promise.all(Array.from({ length: Math.min(ROOM_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const roomId = queue.shift()!
          try {
            await analyzeRoom(dept, ai, roomId, names.get(roomId) || '', from, to, force, quietSec, p)
          } catch (err) {
            if (err instanceof AIConfigError) { queue.length = 0; console.error(`[issues] AI 配置问题，停止分析：${err.message}`); break }
            console.error(`[issues] 群 ${roomId} 分析出错：${(err as Error).message}`)
          }
          p.roomsDone++
        }
      }))
    } finally {
      for (const [roomId, name] of names) {
        if (name) await execute("UPDATE wg_issues SET room_name = ? WHERE department_id = ? AND room_id = ? AND room_name = ''", [name.slice(0, 255), dept.id, roomId]).catch(() => undefined)
      }
      // 会话记录里的对公群跟着更新
      await refreshIssueSessions(dept).catch((e) => console.error('[issues] 群问题写进会话记录失败', e))
      running.delete(dept.code)
      console.log(`[issues] ${dept.name} ${from} ~ ${to} 分析结束：${p.rooms} 个群，调 AI ${p.calls} 次，失败 ${p.failed}`)
    }
  })()
  return p
}

/** 自动：分析最近 3 天（含今天，聊完的群才分析）；第一次从有群消息的第一天开始。对公群每次同步成功后调用 */
export async function autoAnalyze(): Promise<void> {
  for (const dept of await listDepartments()) {
    if (!dept.groupChat || running.has(dept.code)) continue
    if (!isSectionConfigured('ai', await getDeptSetting(dept.code, 'ai'))) continue
    const [any] = await query<{ n: number }>('SELECT COUNT(*) n FROM wg_issue_runs WHERE department_id = ?', [dept.id])
    const [first] = await query<{ t: number | null }>('SELECT MIN(send_time) t FROM wg_messages')
    if (!first?.t) continue
    const today = dayOf(now())
    const from = Number(any?.n) > 0 ? addDays(today, -2) : dayOf(Number(first.t))
    try {
      await startAnalyze(dept, from, today, 'auto')
    } catch (err) {
      console.error(`[issues] ${dept.name} 自动分析没能开始：${(err as Error).message}`)
    }
  }
}
