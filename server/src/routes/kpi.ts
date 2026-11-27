/**
 * 绩效考核接口：考核规则、生成报表（自动存快照）、历史快照、回复率 / 差评剔除、技术支持部的每月人工录入。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { audit, HttpError, resolveDepartment, type Department } from '../auth'
import { execute, now, query } from '../db'
import { deptProjectId } from '../members'
import { defaultRules, getRules, normalizeRules, resetRules, saveRules, type CsRules, type ManualEntry, type TechRules } from '../kpi/rules'
import { loadInputs, SsReportError } from '../kpi/inputs'
import { calcCs } from '../kpi/calc-cs'
import { calcTech, type GroupStats } from '../kpi/calc-tech'
import { confirmedFeedback, coverage, issueStats } from '../kpi/data'
import { refreshIssueSessions } from '../issues/sessions'

const MAX_DAYS = 62
const ANCHOR = 'IF(s.assign_time > 0, s.assign_time, s.start_time)'

const pad = (n: number): string => String(n).padStart(2, '0')
const monthOf = (sec: number): string => {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

async function scope(req: FastifyRequest): Promise<{ dept: Department; projectId: string }> {
  const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
  const projectId = await deptProjectId(dept)
  if (!projectId) throw new HttpError(400, '本部门还没有填 SaleSmartly 项目')
  return { dept, projectId }
}

function parseRange(b: unknown, e: unknown): { begin: number; end: number } {
  const begin = Math.trunc(Number(b))
  const end = Math.trunc(Number(e))
  if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end) throw new HttpError(400, '请选择考核时段')
  if (end - begin > MAX_DAYS * 86400) throw new HttpError(400, `考核时段最长 ${MAX_DAYS} 天`)
  return { begin, end }
}

async function getManual(deptId: number, month: string): Promise<Record<string, ManualEntry>> {
  const rows = await query<{ sys_user_id: number; data: unknown }>(
    'SELECT sys_user_id, data FROM kpi_manual WHERE department_id = ? AND month = ?', [deptId, month]
  )
  const out: Record<string, ManualEntry> = {}
  for (const r of rows) out[String(r.sys_user_id)] = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as ManualEntry
  return out
}

/** 对公群的群问题（只有开了对公群的部门有）；先对一遍，保证处理人、状态、难度是最新的 */
async function loadGroupStats(dept: Department, projectId: string, begin: number, end: number): Promise<GroupStats> {
  if (!dept.groupChat) return {}
  await refreshIssueSessions(dept)
  return issueStats(projectId, dept.id, begin, end)
}

/** 检查会话属于本部门客服 */
async function ownSession(deptId: number, projectId: string, sessionId: string): Promise<void> {
  const [row] = await query(
    `SELECT 1 FROM ss_sessions s JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
     WHERE s.project_id = ? AND s.session_id = ?`, [deptId, projectId, sessionId]
  )
  if (!row) throw new HttpError(404, '会话不存在，或不是本部门客服接待的')
}

export async function kpiRoutes(app: FastifyInstance): Promise<void> {
  // ─── 规则 ───────────────────────────────────────────
  app.get('/api/kpi/rules', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const r = await getRules(dept)
    return { success: true, data: { ...r, template: dept.kpiTemplate, defaults: defaultRules(dept) } }
  })

  app.put('/api/kpi/rules', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    let rules
    try {
      rules = normalizeRules(dept, req.body)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    await saveRules(dept, rules, req.user!.username)
    await audit(req, 'kpi_rules_update', dept.code, rules, dept.id)
    const r = await getRules(dept)
    return { success: true, data: { ...r, template: dept.kpiTemplate, defaults: defaultRules(dept) } }
  })

  app.post('/api/kpi/rules/reset', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    await resetRules(dept)
    await audit(req, 'kpi_rules_reset', dept.code, null, dept.id)
    const r = await getRules(dept)
    return { success: true, data: { ...r, template: dept.kpiTemplate, defaults: defaultRules(dept) } }
  })

  // ─── 生成报表 ───────────────────────────────────────
  /** 生成前的提示：这个时段本地会话的 AI 评分覆盖情况 */
  app.get('/api/kpi/coverage', async (req) => {
    const { dept, projectId } = await scope(req)
    const q = req.query as { begin?: string; end?: string }
    const { begin, end } = parseRange(q.begin, q.end)
    return { success: true, data: await coverage(projectId, dept.id, begin, end) }
  })

  app.post('/api/kpi/calculate', async (req) => {
    const { dept, projectId } = await scope(req)
    const body = (req.body || {}) as { begin?: number; end?: number }
    const { begin, end } = parseRange(body.begin, body.end)
    const { rules } = await getRules(dept)
    const graceSec = dept.kpiTemplate === 'tech' ? (rules as TechRules).part1.replyRate.graceSec : (rules as CsRules).replyGraceSec
    let inputs
    try {
      inputs = await loadInputs(dept, projectId, begin, end, graceSec)
    } catch (err) {
      if (err instanceof SsReportError) throw new HttpError(502, err.message)
      throw err
    }
    const month = monthOf(begin)
    const results = dept.kpiTemplate === 'tech'
      ? calcTech(rules as TechRules, inputs, await getManual(dept.id, month), await loadGroupStats(dept, projectId, begin, end), dept.groupChat ? await confirmedFeedback(projectId, dept.id, begin, end) : {})
      : calcCs(rules as CsRules, inputs)
    const uncached = Object.values(inputs.reply).reduce((s, v) => s + v.uncached, 0)
    const payload = { results, excluded: inputs.excluded, month, replyUncached: uncached }

    const t = now()
    await execute(
      `INSERT INTO kpi_snapshots (department_id, range_begin, range_end, template, rules, results, created_by, created_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)
       ON DUPLICATE KEY UPDATE template = VALUES(template), rules = VALUES(rules), results = VALUES(results),
         created_by = VALUES(created_by), created_at = VALUES(created_at)`,
      [dept.id, begin, end, dept.kpiTemplate, JSON.stringify(rules), JSON.stringify(payload), req.user!.username, t]
    )
    return { success: true, data: { template: dept.kpiTemplate, begin, end, rules, ...payload, createdAt: t, createdBy: req.user!.username } }
  })

  // ─── 快照 ───────────────────────────────────────────
  app.get('/api/kpi/snapshots', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const rows = await query<{ id: number; range_begin: number; range_end: number; created_by: string; created_at: number; n: number }>(
      `SELECT id, range_begin, range_end, created_by, created_at, JSON_LENGTH(results, '$.results') n
       FROM kpi_snapshots WHERE department_id = ? ORDER BY range_begin DESC, range_end DESC LIMIT 100`, [dept.id]
    )
    return {
      success: true,
      data: rows.map((r) => ({ id: r.id, begin: Number(r.range_begin), end: Number(r.range_end), createdBy: r.created_by, createdAt: Number(r.created_at), count: Number(r.n) }))
    }
  })

  app.get('/api/kpi/snapshots/:id', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const [r] = await query<{ range_begin: number; range_end: number; template: string; rules: unknown; results: unknown; created_by: string; created_at: number }>(
      'SELECT * FROM kpi_snapshots WHERE id = ? AND department_id = ?', [Number((req.params as { id: string }).id), dept.id]
    )
    if (!r) throw new HttpError(404, '快照不存在')
    const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v)
    return {
      success: true,
      data: { template: r.template, begin: Number(r.range_begin), end: Number(r.range_end), rules: parse(r.rules), ...(parse(r.results) as object), createdAt: Number(r.created_at), createdBy: r.created_by }
    }
  })

  // ─── 回复率 / 差评明细和剔除 ───────────────────────
  /** 某客服时段内「客户说过话但人工没回」的会话（和回复率同口径） */
  app.get('/api/kpi/unreplied', async (req) => {
    const { dept, projectId } = await scope(req)
    const q = req.query as { begin?: string; end?: string; member?: string }
    const { begin, end } = parseRange(q.begin, q.end)
    const { rules } = await getRules(dept)
    const graceSec = dept.kpiTemplate === 'tech' ? (rules as TechRules).part1.replyRate.graceSec : (rules as CsRules).replyGraceSec
    const rows = await query<{
      session_id: string; customer_name: string; channel: number; start_time: number; anchor: number; end_time: number;
      user_msg_count: number; msgs_synced: number; exempt: number
    }>(
      `SELECT s.session_id, s.customer_name, s.channel, s.start_time, ${ANCHOR} anchor, s.end_time, s.user_msg_count, s.msgs_synced,
              EXISTS (SELECT 1 FROM kpi_exemptions e WHERE e.project_id = s.project_id AND e.session_id = s.session_id AND e.kind = 'reply') exempt
       FROM ss_sessions s
       JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
       WHERE s.project_id = ? AND s.source = 'ss' AND s.sys_user_id = ? AND s.user_msg_count > 0 AND s.end_time > 0
         AND s.start_time BETWEEN ? AND ? AND ${ANCHOR} BETWEEN ? AND ?
         AND IF(s.msgs_synced = 1,
                NOT EXISTS (SELECT 1 FROM ss_messages x WHERE x.project_id = s.project_id AND x.session_id = s.session_id AND x.sender_type = 'staff' AND x.recalled = 0),
                s.kf_msg_count = 0)
       ORDER BY s.start_time DESC`,
      [dept.id, projectId, Number(q.member), begin - 7 * 86400, end, begin, end]
    )
    return {
      success: true,
      data: {
        graceSec,
        list: rows.map((r) => {
          const durationSec = Number(r.end_time) - Number(r.anchor)
          return {
            sessionId: r.session_id, customerName: r.customer_name, channel: r.channel, startTime: Number(r.start_time),
            durationSec, customerMsgCount: r.user_msg_count, uncached: !r.msgs_synced,
            graced: durationSec < graceSec, exempt: !!r.exempt
          }
        })
      }
    }
  })

  /** 某客服时段内客户评过分的会话（低星在前），可以标记申诉剔除 */
  app.get('/api/kpi/scored', async (req) => {
    const { dept, projectId } = await scope(req)
    const q = req.query as { begin?: string; end?: string; member?: string }
    const { begin, end } = parseRange(q.begin, q.end)
    const rows = await query<{ session_id: string; customer_name: string; channel: number; start_time: number; star_score: number; exempt: number }>(
      `SELECT s.session_id, s.customer_name, s.channel, s.start_time, s.star_score,
              EXISTS (SELECT 1 FROM kpi_exemptions e WHERE e.project_id = s.project_id AND e.session_id = s.session_id AND e.kind = 'bad_review') exempt
       FROM ss_sessions s
       JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
       WHERE s.project_id = ? AND s.source = 'ss' AND s.sys_user_id = ? AND s.star_score > 0
         AND s.start_time BETWEEN ? AND ? AND ${ANCHOR} BETWEEN ? AND ?
       ORDER BY s.star_score, s.start_time DESC`,
      [dept.id, projectId, Number(q.member), begin - 7 * 86400, end, begin, end]
    )
    return {
      success: true,
      data: rows.map((r) => ({ sessionId: r.session_id, customerName: r.customer_name, channel: r.channel, startTime: Number(r.start_time), starScore: r.star_score, exempt: !!r.exempt }))
    }
  })

  app.post('/api/kpi/exempt', async (req) => {
    const { dept, projectId } = await scope(req)
    const body = (req.body || {}) as { sessionId?: string; kind?: string; exempt?: boolean }
    const sessionId = String(body.sessionId || '')
    const kind = body.kind === 'bad_review' ? 'bad_review' : body.kind === 'reply' ? 'reply' : ''
    if (!sessionId || !kind) throw new HttpError(400, '参数不对')
    await ownSession(dept.id, projectId, sessionId)
    if (kind === 'bad_review') {
      const [s] = await query<{ star_score: number }>('SELECT star_score FROM ss_sessions WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
      if (body.exempt && !(s?.star_score > 0)) throw new HttpError(400, '这个会话客户没有评分，不用剔除')
    }
    if (body.exempt) {
      await execute(
        'INSERT IGNORE INTO kpi_exemptions (project_id, session_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
        [projectId, sessionId, kind, req.user!.username, now()]
      )
    } else {
      await execute('DELETE FROM kpi_exemptions WHERE project_id = ? AND session_id = ? AND kind = ?', [projectId, sessionId, kind])
    }
    await audit(req, body.exempt ? 'kpi_exempt' : 'kpi_unexempt', `${kind}:${sessionId}`, null, dept.id)
    return { success: true }
  })

  // ─── 技术支持部每月人工录入 ───────────────────────
  app.get('/api/kpi/manual', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const month = String((req.query as { month?: string }).month || '')
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, '月份不对')
    return { success: true, data: await getManual(dept.id, month) }
  })

  app.put('/api/kpi/manual', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    if (dept.kpiTemplate !== 'tech') throw new HttpError(400, '本部门的考核规则没有人工录入项')
    const body = (req.body || {}) as { month?: string; sysUserId?: number; entry?: ManualEntry | null }
    const month = String(body.month || '')
    const uid = Number(body.sysUserId)
    if (!/^\d{4}-\d{2}$/.test(month) || !uid) throw new HttpError(400, '参数不对')
    const { rules } = await getRules(dept)
    const R = rules as TechRules
    if (!body.entry) {
      await execute('DELETE FROM kpi_manual WHERE department_id = ? AND month = ? AND sys_user_id = ?', [dept.id, month, uid])
    } else {
      const e = body.entry
      const n = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Math.max(0, Math.trunc(Number(v)) || 0))
      const clean: ManualEntry = {
        supervisorScore: e.supervisorScore == null || (e.supervisorScore as unknown) === '' ? undefined : Math.min(R.total.supervisorMax, Math.max(0, Number(e.supervisorScore))),
        supervisorNote: e.supervisorNote ? String(e.supervisorNote).slice(0, 500) : undefined,
        p1Complaints: n(e.p1Complaints), p1UnresolvedBad: n(e.p1UnresolvedBad), p1Violation: !!e.p1Violation || undefined,
        p2Complaints: n(e.p2Complaints), p2MildComplaints: n(e.p2MildComplaints), p2Praise: n(e.p2Praise),
        p2Ignored1h: n(e.p2Ignored1h), p2Ignored2h: n(e.p2Ignored2h), p2HandoverMiss: n(e.p2HandoverMiss), p2WrongInfo: n(e.p2WrongInfo),
        p2Violation: !!e.p2Violation || undefined
      }
      await execute(
        `INSERT INTO kpi_manual (department_id, month, sys_user_id, data, updated_by, updated_at) VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
        [dept.id, month, uid, JSON.stringify(clean), req.user!.username, now()]
      )
    }
    await audit(req, 'kpi_manual', `${month}:${uid}`, body.entry ?? null, dept.id)
    return { success: true, data: await getManual(dept.id, month) }
  })
}
