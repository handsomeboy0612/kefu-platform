/**
 * 群问题接口（AI 分问题的结果）：列表、每人汇总、详情、主管核对和修改（处理人 / 状态 / 难度 / 交接 / 依赖上游）、
 * AI 标出的客户反馈（投诉 / 抱怨 / 表扬）的确认。技术支持部第二项按这里的结果计分。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { audit, HttpError, resolveDepartment, type Department } from '../auth'
import { execute, now, query } from '../db'
import { deptProjectId } from '../members'
import { AnalyzeBusyError, analyzeProgress, startAnalyze } from '../issues/analyze'
import { effective, firstAt, issueMetrics, metricsCtx, refreshIssueSessions, type EffIssue, type IssueMsg, type IssueMetrics, type MetricsCtx } from '../issues/sessions'
import { feedbackItems, type FeedbackItem } from '../kpi/data'
import { getRules, type TechRules } from '../kpi/rules'
import { closureValue, difficultyWeight, issueBreakdown } from '../kpi/calc-tech'

interface IssueRow {
  id: number; room_id: string; room_name: string; day: string; anchor_msg_id: string; summary: string
  message_ids: unknown; handler_user_id: string; handler_reason: string | null; helper_ids: unknown; status: string
  resolved_msg_id: string; evidence: string | null; first_customer_at: number; first_reply_at: number; resolved_at: number
  boundary_ok: number | null; handler_ok: number | null; status_ok: number | null; note: string | null
  override_handler: string | null; override_status: string | null; difficulty: number | null; mark_by: string | null
  handed_from: string; handover: string; upstream: number; difficulty_ai: number; feedback: unknown
  override_handed_from: string | null; override_handover: string | null; override_upstream: number | null; override_ignored: number | null
}

const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T))
/** AI 只会判 resolved / unresolved / unknown；交接完整 handed、交接不完整 handed_part 由主管标（闭环率按 0.8 / 0.4 算） */
const STATUS = ['resolved', 'unresolved', 'unknown', 'handed', 'handed_part']

async function groupDept(req: FastifyRequest): Promise<Department> {
  const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
  if (!dept.groupChat) throw new HttpError(404, '本部门没有对公群')
  return dept
}

/** 员工（企微）→ 成员、是否计入本部门 */
async function staffIndex(dept: Department): Promise<Map<string, { nick: string; sysUserId: number; member: string; counted: boolean }>> {
  const projectId = await deptProjectId(dept)
  const rows = await query<{ user_id: string; nickname: string; raw_name: string; sys_user_id: number; mname: string | null; department_id: number | null; participate: number | null; active: number | null }>(
    `SELECT w.user_id, w.nickname, w.raw_name, w.sys_user_id, m.nickname mname, m.department_id, m.participate, m.active
     FROM wg_staff w LEFT JOIN members m ON m.project_id = ? AND m.sys_user_id = w.sys_user_id AND w.sys_user_id > 0`,
    [projectId]
  )
  return new Map(rows.map((r) => [r.user_id, {
    nick: r.nickname || r.raw_name || r.user_id,
    sysUserId: Number(r.sys_user_id),
    member: r.mname || '',
    counted: !!r.mname && r.department_id === dept.id && !!r.participate && !!r.active
  }]))
}

/** 本部门成员（SaleSmartly 成员 ID → 名字、是否参与考核） */
async function memberIndex(dept: Department): Promise<Map<number, { name: string; counted: boolean }>> {
  const rows = await query<{ sys_user_id: number; nickname: string; participate: number; active: number }>(
    'SELECT sys_user_id, nickname, participate, active FROM members WHERE project_id = ? AND department_id = ?', [await deptProjectId(dept), dept.id]
  )
  return new Map(rows.map((r) => [Number(r.sys_user_id), { name: r.nickname, counted: !!r.participate && !!r.active }]))
}

interface Ctx { staff: Awaited<ReturnType<typeof staffIndex>>; members: Awaited<ReturnType<typeof memberIndex>> }
const loadCtx = async (dept: Department): Promise<Ctx> => ({ staff: await staffIndex(dept), members: await memberIndex(dept) })
/** 本部门的人（企微 user_id 挂到了本部门成员上）：没人回复的问题，按问题里被 @ 的这些人算 */
const inDept = (c: Ctx) => (userId: string): boolean => { const st = c.staff.get(userId); return !!st && c.members.has(st.sysUserId) }
const noAiHandler = (r: IssueRow): boolean => (r.override_handler === null || r.override_handler === undefined) && !r.handler_user_id

/** 按现在的处理人、状态算每个问题的首响 / 均响 / 处理时效（和绩效第二项、会话记录同一个口径） */
async function metricsFor(rows: IssueRow[], ctx: MetricsCtx, eff: Map<number, EffIssue>): Promise<Map<number, IssueMetrics>> {
  const ids = [...new Set(rows.flatMap((r) => json<string[]>(r.message_ids, [])))]
  const msgs = new Map<string, IssueMsg>()
  for (let i = 0; i < ids.length; i += 1000) {
    for (const m of await query<IssueMsg>('SELECT msg_id, sender_id, is_staff, is_self, at_list, content, send_time FROM wg_messages WHERE msg_id IN (?)', [ids.slice(i, i + 1000)])) msgs.set(m.msg_id, m)
  }
  return new Map(rows.map((r) => [r.id, issueMetrics(
    json<string[]>(r.message_ids, []).map((id) => msgs.get(id)).filter((m): m is IssueMsg => !!m),
    eff.get(r.id)!.handler, ctx, eff.get(r.id)!.status, Number(r.resolved_at)
  )]))
}

const DIFF_TEXT: Record<number, string> = { 1: '简单', 2: '一般', 3: '疑难' }

function view(r: IssueRow, c: Ctx, e: EffIssue, mt?: IssueMetrics): Record<string, unknown> {
  const { staff, members } = c
  const st = staff.get(e.handler)
  const hf = e.handedFrom ? staff.get(e.handedFrom) : undefined
  const has = (v: unknown): boolean => v !== null && v !== undefined
  const fb = json<Array<{ msg_id: string }>>(r.feedback, [])
  return {
    id: r.id,
    day: r.day,
    roomName: r.room_name || r.room_id,
    summary: r.summary,
    messageCount: json<string[]>(r.message_ids, []).length,
    handlerUserId: e.handler,
    handlerName: e.handler ? st?.nick || e.handler : '',
    handlerMember: e.handler ? st?.member || '' : '',
    /** 计入的成员：处理人（自己回复的，或者没人回复时被 @ 的）是本部门参与考核的 */
    ownerSysUserId: e.handler && st?.counted ? st.sysUserId : 0,
    counted: !!st?.counted,
    /** 我方没人回复、按被 @ 的人算的 */
    atAssigned: e.atAssigned,
    ignoredOff: e.ignoredOff,
    ignored1h: mt && !e.ignoredOff ? mt.ignored1h : 0,
    ignored2h: mt && !e.ignoredOff ? mt.ignored2h : 0,
    handlerReason: r.handler_reason || '',
    aiHandlerName: r.handler_user_id ? staff.get(r.handler_user_id)?.nick || r.handler_user_id : '',
    status: e.status,
    aiStatus: r.status,
    overridden: has(r.override_handler) || !!r.override_status || has(r.override_handed_from) || has(r.override_handover) || has(r.override_upstream) || has(r.override_ignored),
    evidence: r.evidence || '',
    firstCustomerAt: Number(r.first_customer_at),
    firstReplySec: mt ? mt.firstSec : null,
    avgReplySec: mt ? mt.avgSec : null,
    syncGapSec: mt ? mt.syncGapSec : null,
    resolveSec: mt ? mt.resolveSec : null,
    difficulty: e.difficulty,
    difficultyAi: e.difficultyAi,
    difficultyMarked: e.difficultyMarked,
    difficultyText: DIFF_TEXT[e.difficulty],
    handedFromUserId: e.handedFrom,
    handedFromName: e.handedFrom ? hf?.nick || e.handedFrom : '',
    handedFromSysUserId: hf?.counted ? hf.sysUserId : 0,
    handover: e.handover,
    upstream: e.upstream,
    feedbackCount: fb.length,
    review: r.boundary_ok === null && r.handler_ok === null && r.status_ok === null ? null
      : { boundaryOk: r.boundary_ok, handlerOk: r.handler_ok, statusOk: r.status_ok, note: r.note || '', by: r.mark_by || '' }
  }
}

const SELECT = `
  SELECT i.*, k.boundary_ok, k.handler_ok, k.status_ok, k.note, k.override_handler, k.override_status, k.difficulty, k.updated_by mark_by,
         k.override_handed_from, k.override_handover, k.override_upstream, k.override_ignored
  FROM wg_issues i
  LEFT JOIN wg_issue_marks k ON k.department_id = i.department_id AND k.room_id = i.room_id AND k.anchor_msg_id = i.anchor_msg_id`

/** 机器人存消息时把「@某某」从正文里去掉了（只存在 at_list 里），显示时补回到前面；只 @ 人的消息正文是空的 */
function withAts(content: string, atList: unknown): string {
  const ats = json<Array<{ user_id?: string; nickname?: string }>>(atList, []).map((a) => a.nickname || a.user_id || '').filter(Boolean)
  const body = (content || '').trim()
  const prefix = ats.map((n) => `@${n}`).join(' ')
  return [prefix, body].filter(Boolean).join(' ') || '[消息]'
}

const FB_TEXT: Record<string, string> = { complaint: '有效投诉', mild: '轻度抱怨', praise: '点名表扬' }
function feedbackView(f: FeedbackItem, c: Ctx): Record<string, unknown> & { msgId: string; kind: string } {
  const t = c.staff.get(f.target)
  return {
    msgId: f.msgId, issueId: f.issueId, roomName: f.roomName, day: f.day, at: f.at, quote: f.quote, reason: f.reason,
    kind: f.kind, kindText: FB_TEXT[f.kind] || f.kind, aiKind: f.aiKind, ownFault: f.ownFault,
    targetUserId: f.target, targetName: t?.nick || f.target || '—', targetCounted: !!t?.counted,
    decision: f.decision, by: f.by, counted: f.counted
  }
}

const avg = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

export async function issueRoutes(app: FastifyInstance): Promise<void> {
  /** 问题列表 + 每人汇总 + 核对准确率 + 分析情况 */
  app.get('/api/issues', async (req) => {
    const dept = await groupDept(req)
    const q = req.query as Record<string, string | undefined>
    const from = String(q.from || '')
    const to = String(q.to || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError(400, '请选择日期')
    const c = await loadCtx(dept)
    const { staff } = c
    const rows = await query<IssueRow>(`${SELECT} WHERE i.department_id = ? AND i.day BETWEEN ? AND ? ORDER BY i.day DESC, i.first_customer_at DESC, i.id DESC`, [dept.id, from, to])
    // 我方没人回复的问题，按被 @ 的本部门的人算（要看消息的 at_list）
    const noH = rows.filter(noAiHandler)
    const atMsgs = new Map<string, { at_list: unknown; send_time: number }>()
    const atIds = [...new Set(noH.flatMap((r) => json<string[]>(r.message_ids, [])))]
    for (let i = 0; i < atIds.length; i += 1000) {
      for (const m of await query<{ msg_id: string; at_list: unknown; send_time: number }>('SELECT msg_id, at_list, send_time FROM wg_messages WHERE msg_id IN (?)', [atIds.slice(i, i + 1000)])) atMsgs.set(m.msg_id, m)
    }
    const atOwner = (r: IssueRow): string => noAiHandler(r)
      ? firstAt(json<string[]>(r.message_ids, []).map((id) => atMsgs.get(id)).filter((m): m is { at_list: unknown; send_time: number } => !!m), inDept(c)) : ''
    const eff = new Map(rows.map((r) => [r.id, effective(r, atOwner(r))]))
    const mts = await metricsFor(rows, await metricsCtx(), eff)
    const all = rows.map((r) => view(r, c, eff.get(r.id)!, mts.get(r.id)))

    // 每人汇总（和绩效第二项一个口径）：只算本部门参与考核的处理人（自己回复的，或者我方没人回复时被 @ 的）；
    // 交接完整的，交接人和处理人各记 0.5 个，交接人的闭环按交接情况算；其余（商务、客服等）只计数
    const P = dept.kpiTemplate === 'tech' ? ((await getRules(dept)).rules as TechRules).part2 : null
    type Person = { name: string; sysUserId: number; issues: number; weighted: number; resolved: number; unresolved: number; handed: number; handedOut: number; unknown: number; closure: number[]; first: number[]; resolve: number[] }
    const blank = (name: string, sysUserId: number): Person => ({ name, sysUserId, issues: 0, weighted: 0, resolved: 0, unresolved: 0, handed: 0, handedOut: 0, unknown: 0, closure: [], first: [], resolve: [] })
    const people = new Map<number, Person>()
    const person = (uid: number): Person => {
      if (!people.has(uid)) people.set(uid, blank(c.members.get(uid)?.name || String(uid), uid))
      return people.get(uid)!
    }
    let others = 0
    let nobody = 0
    for (const x of all) {
      const owner = Number(x.ownerSysUserId)
      const full = x.handover === 'full' && Number(x.handedFromSysUserId) > 0
      const dw = P ? difficultyWeight(P, x.difficulty as number) : 1
      if (Number(x.handedFromSysUserId) > 0 && Number(x.handedFromSysUserId) !== owner) {
        const h = person(Number(x.handedFromSysUserId))
        h.handedOut++
        h.weighted += full ? dw * 0.5 : 0
        h.closure.push(full ? P?.closureRule.handedFull ?? 0.8 : x.handover === 'part' ? P?.closureRule.handedPart ?? 0.4 : 0)
      }
      if (!owner) { if (!x.handlerUserId) nobody++; else others++; continue }
      const p = person(owner)
      p.issues++
      p.weighted += dw * (full ? 0.5 : 1)
      if (x.status === 'resolved') p.resolved++
      else if (x.status === 'unresolved') p.unresolved++
      else if (x.status === 'handed' || x.status === 'handed_part') p.handed++
      else p.unknown++
      const cv = P ? closureValue(P, String(x.status)) : null
      if (cv !== null) p.closure.push(cv)
      if (x.firstReplySec != null) p.first.push(x.firstReplySec as number)
      if (x.resolveSec != null) p.resolve.push(x.resolveSec as number)
    }
    const summary = [...people.values()].map((p) => ({
      name: p.name, sysUserId: p.sysUserId, issues: p.issues, weighted: Math.round(p.weighted * 10) / 10,
      resolved: p.resolved, unresolved: p.unresolved, handed: p.handed, handedOut: p.handedOut, unknown: p.unknown,
      // 闭环率 = 各问题计分之和 ÷ 问题数（解决 1、交接完整 0.8、交接不完整 0.4、没解决 0；判断不了的确认前不算）
      closureRate: p.closure.length ? Math.round((p.closure.reduce((a, b) => a + b, 0) / p.closure.length) * 1000) / 10 : null,
      avgFirstSec: avg(p.first), avgResolveSec: avg(p.resolve)
    })).sort((a, b) => b.issues - a.issues)

    // 核对准确率：三项都核对过的问题里，三项全对的比例
    const reviewed = all.filter((x) => x.review && (x.review as { boundaryOk: number | null }).boundaryOk !== null && (x.review as { handlerOk: number | null }).handlerOk !== null && (x.review as { statusOk: number | null }).statusOk !== null)
    const ok = (k: 'boundaryOk' | 'handlerOk' | 'statusOk'): number => reviewed.filter((x) => (x.review as Record<string, number>)[k] === 1).length
    const allOk = reviewed.filter((x) => { const r = x.review as Record<string, number>; return r.boundaryOk === 1 && r.handlerOk === 1 && r.statusOk === 1 }).length

    // 筛选 + 分页
    let list = all
    if (q.handler === 'none') list = list.filter((x) => !x.handlerUserId)
    else if (q.handler === 'others') list = list.filter((x) => !x.ownerSysUserId && x.handlerUserId)
    else if (q.handler === 'at') list = list.filter((x) => x.atAssigned)
    else if (q.handler) list = list.filter((x) => String(x.ownerSysUserId) === q.handler || String(x.handedFromSysUserId) === q.handler)
    if (q.status && STATUS.includes(q.status)) list = list.filter((x) => x.status === q.status)
    if (q.review === 'unreviewed') list = list.filter((x) => !x.review)
    else if (q.review === 'reviewed') list = list.filter((x) => !!x.review)
    else if (q.review === 'wrong') list = list.filter((x) => { const r = x.review as Record<string, number> | null; return !!r && (r.boundaryOk === 0 || r.handlerOk === 0 || r.statusOk === 0) })
    const kw = (q.keyword || '').trim()
    if (kw) list = list.filter((x) => `${x.summary} ${x.roomName} ${x.evidence}`.includes(kw))
    const page = Math.max(1, Number(q.page) || 1)
    const pageSize = Math.min(100, Math.max(10, Number(q.pageSize) || 20))

    const runs = await query<{ status: string; n: number; tin: number; tout: number; last: number }>(
      `SELECT status, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout, MAX(updated_at) last FROM wg_issue_runs
       WHERE department_id = ? AND day BETWEEN ? AND ? GROUP BY status`, [dept.id, from, to]
    )
    const failed = await query<{ room_id: string; day: string; error: string }>(
      "SELECT room_id, day, error FROM wg_issue_runs WHERE department_id = ? AND day BETWEEN ? AND ? AND status = 'failed' ORDER BY day DESC LIMIT 20", [dept.id, from, to]
    )
    return {
      success: true,
      data: {
        total: list.length,
        list: list.slice((page - 1) * pageSize, page * pageSize),
        counts: { all: all.length, others, nobody, atAssigned: all.filter((x) => x.atAssigned).length },
        // AI 判断计入的投诉 / 抱怨 / 表扬（针对本部门参与考核的人的）
        feedbackCounted: (await feedbackItems(dept.id)).filter((f) => f.counted && f.day >= from && f.day <= to && !!c.staff.get(f.target)?.counted).length,
        summary,
        accuracy: { reviewed: reviewed.length, allOk, boundaryOk: ok('boundaryOk'), handlerOk: ok('handlerOk'), statusOk: ok('statusOk') },
        analysis: {
          progress: analyzeProgress(dept.code),
          ok: Number(runs.find((r) => r.status === 'ok')?.n || 0),
          failed: Number(runs.find((r) => r.status === 'failed')?.n || 0),
          tokens: runs.reduce((s, r) => s + Number(r.tin || 0) + Number(r.tout || 0), 0),
          lastAt: Math.max(0, ...runs.map((r) => Number(r.last || 0))),
          failures: failed
        },
        handlers: [...staff.values()].filter((s) => s.counted).map((s) => ({ sysUserId: s.sysUserId, name: s.member }))
          .filter((v, i, a) => a.findIndex((y) => y.sysUserId === v.sysUserId) === i)
      }
    }
  })

  /** 问题详情：全部消息（标出解决那条）、可选的处理人 */
  app.get('/api/issues/:id', async (req) => {
    const dept = await groupDept(req)
    const id = Number((req.params as { id: string }).id)
    const [r] = await query<IssueRow>(`${SELECT} WHERE i.department_id = ? AND i.id = ?`, [dept.id, id])
    if (!r) throw new HttpError(404, '问题不存在')
    const c = await loadCtx(dept)
    const { staff } = c
    const ids = json<string[]>(r.message_ids, [])
    const msgs = ids.length ? await query<{ msg_id: string; sender_id: string; sender_name: string; is_staff: number; is_self: number; at_list: unknown; content: string; send_time: number }>(
      'SELECT msg_id, sender_id, sender_name, is_staff, is_self, at_list, content, send_time FROM wg_messages WHERE msg_id IN (?) ORDER BY send_time, msg_id', [ids]
    ) : []
    const e = effective(r, noAiHandler(r) ? firstAt(msgs, inDept(c)) : '')
    // 按现在的处理人（主管改过的优先）算首响 / 均响 / 处理时长和单题分（第二项规则）
    const mt = issueMetrics(msgs, e.handler, await metricsCtx(), e.status, Number(r.resolved_at))
    const v = view(r, c, e, mt)
    const P = dept.kpiTemplate === 'tech' ? ((await getRules(dept)).rules as TechRules).part2 : null
    const fbs = (await feedbackItems(dept.id)).filter((f) => f.issueId === r.id).map((f) => feedbackView(f, c))
    const fbBy = new Map(fbs.map((f) => [f.msgId, f]))
    // 评分明细：首响、均响、处理时效、是否解决逐项打分，晾着客户 / 交接遗漏 / 投诉抱怨表扬列出来
    const bd = P ? issueBreakdown(P, {
      firstSec: mt.firstSec, firstFrom: mt.firstFrom, avgSec: mt.avgSec, rounds: mt.rounds, status: e.status, resolveSec: mt.resolveSec,
      syncGapSec: mt.syncGapSec, upstream: e.upstream, ignoredWaits: mt.ignoredWaits, ignoredOff: e.ignoredOff,
      handedFromName: String(v.handedFromName || ''), handover: e.handover, atAssigned: e.atAssigned,
      feedback: fbs.filter((f) => f.targetUserId === e.handler || !e.handler).map((f) => ({ kind: f.kind, quote: String(f.quote), counted: !!f.counted }))
    }) : null
    const helpers = json<string[]>(r.helper_ids, []).map((h) => staff.get(h)?.nick || h)
    const speakers = [...new Set(msgs.filter((m) => m.is_staff && !m.is_self).map((m) => m.sender_id))]
    const options = [...new Set([...speakers, ...[...staff.entries()].filter(([, s]) => s.counted).map(([k]) => k)])]
      .map((uid) => ({ userId: uid, name: staff.get(uid)?.nick || uid, counted: !!staff.get(uid)?.counted }))
    return {
      success: true,
      data: {
        issue: {
          ...v, helpers, resolvedMsgId: r.resolved_msg_id,
          score: bd?.score ?? null,
          scoreParts: bd ? Object.fromEntries(bd.items.map((i) => [i.key, i.score === null ? null : (i.score / i.full) * 100])) : null,
          breakdown: bd
        },
        messages: msgs.map((m) => ({
          id: m.msg_id,
          senderType: m.is_self ? 'bot' : m.is_staff ? 'staff' : 'customer',
          senderName: m.is_staff ? staff.get(m.sender_id)?.nick || m.sender_name : m.sender_name,
          content: withAts(m.content, m.at_list),
          sendTime: Number(m.send_time),
          isResolved: m.msg_id === r.resolved_msg_id,
          feedbackKind: fbBy.get(m.msg_id)?.kind || ''
        })),
        feedback: fbs,
        handlerOptions: options
      }
    }
  })

  async function mark(req: FastifyRequest, patch: Record<string, unknown>): Promise<void> {
    const dept = await groupDept(req)
    const id = Number((req.params as { id: string }).id)
    const [r] = await query<{ room_id: string; anchor_msg_id: string }>('SELECT room_id, anchor_msg_id FROM wg_issues WHERE department_id = ? AND id = ?', [dept.id, id])
    if (!r) throw new HttpError(404, '问题不存在')
    const cols = Object.keys(patch)
    await execute(
      `INSERT INTO wg_issue_marks (department_id, room_id, anchor_msg_id, ${cols.join(', ')}, updated_by, updated_at)
       VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')}, ?, ?)
       ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [dept.id, r.room_id, r.anchor_msg_id, ...cols.map((c) => patch[c]), req.user!.username, now()]
    )
    await audit(req, 'issue_mark', `${id}`, patch, dept.id)
  }

  /** 核对：问题边界、处理人、状态三项各自对不对（null = 没核对） */
  app.put('/api/issues/:id/review', async (req) => {
    const b = (req.body || {}) as { boundaryOk?: number | null; handlerOk?: number | null; statusOk?: number | null; note?: string }
    const v = (x: unknown): number | null => (x === 1 || x === true ? 1 : x === 0 || x === false ? 0 : null)
    await mark(req, { boundary_ok: v(b.boundaryOk), handler_ok: v(b.handlerOk), status_ok: v(b.statusOk), note: String(b.note || '').slice(0, 1000) })
    return { success: true }
  })

  /**
   * 主管修改（null = 恢复 AI 的判断）；改过的 AI 重跑也不覆盖：
   * 处理人（'' = 不归任何人）、状态、难度（1 简单 / 2 一般 / 3 疑难）、交接人（'' = 没有交接）、交接情况（full / part / none）、依赖上游
   */
  app.put('/api/issues/:id/override', async (req) => {
    const b = (req.body || {}) as { handlerUserId?: string | null; status?: string | null; difficulty?: number | null; handedFromUserId?: string | null; handover?: string | null; upstream?: boolean | null; ignored?: boolean | null }
    const patch: Record<string, unknown> = {}
    if ('handlerUserId' in b) patch.override_handler = b.handlerUserId === null || b.handlerUserId === undefined ? null : String(b.handlerUserId).slice(0, 128)
    if ('status' in b) {
      if (b.status !== null && b.status !== undefined && !STATUS.includes(String(b.status))) throw new HttpError(400, '状态不对')
      patch.override_status = b.status ?? null
    }
    if ('difficulty' in b) {
      if (b.difficulty !== null && b.difficulty !== undefined && ![1, 2, 3].includes(Number(b.difficulty))) throw new HttpError(400, '难度不对')
      patch.difficulty = b.difficulty == null ? null : Number(b.difficulty)
    }
    if ('handedFromUserId' in b) patch.override_handed_from = b.handedFromUserId == null ? null : String(b.handedFromUserId).slice(0, 128)
    if ('handover' in b) {
      if (b.handover != null && !['full', 'part', 'none'].includes(String(b.handover))) throw new HttpError(400, '交接情况不对')
      patch.override_handover = b.handover ?? null
    }
    if ('upstream' in b) patch.override_upstream = b.upstream == null ? null : b.upstream ? 1 : 0
    // 晾着客户：false = 这个问题不扣（比如客户自己说了不急），null = 按程序算
    if ('ignored' in b) patch.override_ignored = b.ignored === false ? 0 : null
    if (!Object.keys(patch).length) throw new HttpError(400, '没有要改的')
    await mark(req, patch)
    // 会话记录里这一行跟着改（处理人换了会挂到新的人名下）
    await refreshIssueSessions(await groupDept(req))
    return { success: true }
  })

  /** AI 标出的客户反馈（投诉 / 抱怨 / 表扬）：按问题开始日期筛，decision = pending / ok / no */
  app.get('/api/issues/feedback', async (req) => {
    const dept = await groupDept(req)
    const q = req.query as Record<string, string | undefined>
    const from = String(q.from || '0000-00-00')
    const to = String(q.to || '9999-99-99')
    const c = await loadCtx(dept)
    let list = (await feedbackItems(dept.id)).filter((f) => f.day >= from && f.day <= to)
    if (q.decision === 'counted') list = list.filter((f) => f.counted)
    else if (q.decision === 'not') list = list.filter((f) => !f.counted)
    else if (q.decision === 'changed') list = list.filter((f) => f.decision !== null)
    // 默认只列针对本部门参与考核的人的（只有这些计入绩效）；计入的排前面
    if (q.scope !== 'all') list = list.filter((f) => !!c.staff.get(f.target)?.counted)
    list.sort((a, b) => Number(b.counted) - Number(a.counted) || b.at - a.at)
    return { success: true, data: list.map((f) => feedbackView(f, c)) }
  })

  /** 主管改一条客户反馈：decision = ok 算 / no 不算 / null 恢复 AI 的判断；可以改类型和针对的人 */
  app.put('/api/issues/feedback/:msgId', async (req) => {
    const dept = await groupDept(req)
    const msgId = (req.params as { msgId: string }).msgId
    const b = (req.body || {}) as { decision?: string | null; kind?: string | null; targetUserId?: string | null }
    const item = (await feedbackItems(dept.id)).find((f) => f.msgId === msgId)
    if (!item) throw new HttpError(404, '没有这条客户反馈')
    if (b.decision == null) {
      await execute('DELETE FROM wg_feedback_marks WHERE department_id = ? AND msg_id = ?', [dept.id, msgId])
    } else {
      if (!['ok', 'no'].includes(String(b.decision))) throw new HttpError(400, '判定不对')
      if (b.kind != null && !['complaint', 'mild', 'praise'].includes(String(b.kind))) throw new HttpError(400, '类型不对')
      await execute(
        `INSERT INTO wg_feedback_marks (department_id, msg_id, decision, kind, target_user, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE decision = VALUES(decision), kind = VALUES(kind), target_user = VALUES(target_user), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
        [dept.id, msgId, b.decision, b.kind ?? null, b.targetUserId ? String(b.targetUserId).slice(0, 128) : null, req.user!.username, now()]
      )
    }
    await audit(req, 'issue_feedback', msgId, b, dept.id)
    return { success: true }
  })

  /** 手动重新分析一段时间（force = 不用缓存，全部重调 AI） */
  app.post('/api/issues/analyze', async (req) => {
    const dept = await groupDept(req)
    const b = (req.body || {}) as { from?: string; to?: string; force?: boolean }
    const from = String(b.from || '')
    const to = String(b.to || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new HttpError(400, '请选择日期')
    try {
      const p = await startAnalyze(dept, from, to, req.user!.username, !!b.force)
      await audit(req, 'issue_analyze', dept.code, { from, to, force: !!b.force }, dept.id)
      return { success: true, data: p }
    } catch (err) {
      throw new HttpError(err instanceof AnalyzeBusyError ? 409 : 400, (err as Error).message)
    }
  })

  app.get('/api/issues/progress', async (req) => {
    const dept = await groupDept(req)
    return { success: true, data: analyzeProgress(dept.code) }
  })
}
