/**
 * 统计看板：
 * - 在线咨询（SaleSmartly）：会话量、客户评价（好评 / 差评）、AI 质检，按天和按客服汇总；本部门客服接待的、按会话开始时间落在时段内。
 *   好评 = 4~5 星，差评 = 1~2 星，3 星算中评。
 * - 对公群（开了对公群的部门）：AI 整理的群问题，口径和绩效第二项一致——只算本部门成员处理的，按客户第一次提问的时间算在哪天，
 *   闭环率 = 解决 1、交接完整 / 不完整按考核规则、没解决 0，判断不了的不算。
 */
import type { FastifyInstance } from 'fastify'
import { HttpError, resolveDepartment, type Department } from '../auth'
import { query } from '../db'
import { deptProjectId } from '../members'
import { getRules, TECH_DEFAULT_RULES, type TechRules } from '../kpi/rules'
import { closureValue } from '../kpi/calc-tech'
import { issueCredits } from '../kpi/data'

const MAX_DAYS = 93

type GroupAgg = { issues: number; resolved: number; unresolved: number; handed: number; unknown: number; closure: number[]; first: number[]; resolve: number[] }
const blankAgg = (): GroupAgg => ({ issues: 0, resolved: 0, unresolved: 0, handed: 0, unknown: 0, closure: [], first: [], resolve: [] })
const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
type GroupShape = { issues: number; resolved: number; unresolved: number; handed: number; unknown: number; closureRate: number | null; avgFirstSec: number | null; avgResolveSec: number | null }
const shapeGroup = (a: GroupAgg): GroupShape => ({
  issues: a.issues, resolved: a.resolved, unresolved: a.unresolved, handed: a.handed, unknown: a.unknown,
  closureRate: a.closure.length ? Math.round((a.closure.reduce((x, y) => x + y, 0) / a.closure.length) * 1000) / 10 : null,
  avgFirstSec: mean(a.first), avgResolveSec: mean(a.resolve)
})

/** 对公群：本部门成员处理的群问题（和绩效第二项同一份数据） */
async function groupBlock(dept: Department, projectId: string, begin: number, end: number, onlyAssessed: boolean): Promise<Record<string, unknown>> {
  const P = dept.kpiTemplate === 'tech' ? ((await getRules(dept)).rules as TechRules).part2 : TECH_DEFAULT_RULES.part2
  const credits = (await issueCredits(projectId, dept.id, begin, end)).filter((c) => !onlyAssessed || c.participate)
  const total = blankAgg()
  const byDay = new Map<string, GroupAgg>()
  const byMember = new Map<number, GroupAgg & { name: string; participate: boolean }>()
  const pad = (n: number): string => String(n).padStart(2, '0')
  for (const c of credits) {
    const d = new Date(c.at * 1000)
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    if (!byDay.has(day)) byDay.set(day, blankAgg())
    if (!byMember.has(c.sysUserId)) byMember.set(c.sysUserId, { ...blankAgg(), name: c.name, participate: c.participate })
    const t = c.thread
    const handover = t.kind === 'handover'
    // 合计和每天：一个问题只算一次（交接出去的那一份不再算）；按人：交接出去的那一份只算闭环率和「交接」
    for (const a of handover ? [byMember.get(c.sysUserId)!] : [total, byDay.get(day)!, byMember.get(c.sysUserId)!]) {
      if (handover) a.handed++
      else {
        a.issues++
        if (t.status === 'resolved') a.resolved++
        else if (t.status === 'unresolved') a.unresolved++
        else if (t.status === 'handed' || t.status === 'handed_part') a.handed++
        else a.unknown++
        if (t.firstSec != null) a.first.push(t.firstSec)
        if (t.status === 'resolved' && t.resolveSec != null) a.resolve.push(t.resolveSec)
      }
      const cv = closureValue(P, t.status)
      if (cv !== null) a.closure.push(cv)
    }
  }
  // 没有群问题的天补 0，折线不会把中间空着的天连过去
  for (let t = begin; t <= Math.min(end, Math.floor(Date.now() / 1000)); t += 86400) {
    const d = new Date(t * 1000)
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    if (!byDay.has(day)) byDay.set(day, blankAgg())
  }
  return {
    summary: shapeGroup(total),
    daily: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, a]) => ({ date, ...shapeGroup(a) })),
    byMember: [...byMember.entries()].map(([uid, a]) => ({ sysUserId: uid, name: a.name, participate: a.participate, ...shapeGroup(a) }))
      .sort((x, y) => y.issues - x.issues)
  }
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async (req) => {
    const q = req.query as { dept?: string; begin?: string; end?: string; participate?: string }
    const dept = await resolveDepartment(req, q.dept)
    const projectId = await deptProjectId(dept)
    const begin = Math.trunc(Number(q.begin))
    const end = Math.trunc(Number(q.end))
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end) throw new HttpError(400, '请选择时间段')
    if (end - begin > MAX_DAYS * 86400) throw new HttpError(400, `一次最多看 ${MAX_DAYS} 天`)
    if (!projectId) return { success: true, data: null }

    const onlyAssessed = q.participate === '1'
    const from = `
      FROM ss_sessions s
      JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
      LEFT JOIN ai_scores sc ON sc.project_id = s.project_id AND sc.session_id = s.session_id AND sc.status = 'ok'
      WHERE s.project_id = ? AND s.source = 'ss' AND s.start_time BETWEEN ? AND ?${onlyAssessed ? ' AND m.participate = 1 AND m.active = 1' : ''}`
    const params = [dept.id, projectId, begin, end]
    const agg = `
      COUNT(*) sessions,
      SUM(s.user_msg_count > 0) spoke,
      SUM(s.star_score > 0) reviewed,
      SUM(s.star_score) star_sum,
      SUM(s.star_score >= 4) good,
      SUM(s.star_score = 3) mid,
      SUM(s.star_score BETWEEN 1 AND 2) bad,
      COUNT(sc.session_id) ai_count,
      SUM(sc.total_score) ai_sum,
      SUM(sc.grade IN ('优秀', '良好')) ai_good`

    type Agg = { sessions: number; spoke: number; reviewed: number; star_sum: number; good: number; mid: number; bad: number; ai_count: number; ai_sum: number; ai_good: number }
    const shape = (a: Agg): Record<string, number | null> => {
      const reviewed = Number(a.reviewed || 0)
      const aiCount = Number(a.ai_count || 0)
      return {
        sessions: Number(a.sessions || 0),
        spoke: Number(a.spoke || 0),
        reviewed,
        avgStar: reviewed ? Math.round((Number(a.star_sum || 0) / reviewed) * 100) / 100 : null,
        good: Number(a.good || 0),
        mid: Number(a.mid || 0),
        bad: Number(a.bad || 0),
        aiCount,
        aiAvg: aiCount ? Math.round((Number(a.ai_sum || 0) / aiCount) * 10) / 10 : null,
        aiGoodRate: aiCount ? Math.round((Number(a.ai_good || 0) / aiCount) * 1000) / 10 : null
      }
    }

    const [summary] = await query<Agg>(`SELECT ${agg} ${from}`, params)
    const daily = await query<Agg & { day: string }>(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(s.start_time), '%Y-%m-%d') day, ${agg} ${from} GROUP BY day ORDER BY day`, params
    )
    const byMember = await query<Agg & { uid: number; name: string; participate: number; active: number }>(
      `SELECT s.sys_user_id uid, MAX(m.nickname) name, MAX(m.participate) participate, MAX(m.active) active, ${agg} ${from}
       GROUP BY s.sys_user_id ORDER BY sessions DESC`, params
    )
    const grades = await query<{ grade: string; n: number }>(
      `SELECT sc.grade, COUNT(*) n ${from} AND sc.session_id IS NOT NULL GROUP BY sc.grade`, params
    )
    return {
      success: true,
      data: {
        group: dept.groupChat ? await groupBlock(dept, projectId, begin, end, onlyAssessed) : null,
        summary: shape(summary),
        daily: daily.map((d) => ({ date: d.day, ...shape(d) })),
        byMember: byMember.map((m) => ({ sysUserId: Number(m.uid), name: m.name, participate: !!m.participate && !!m.active, ...shape(m) })),
        grades: grades.map((g) => ({ grade: g.grade, count: Number(g.n) }))
      }
    }
  })
}
