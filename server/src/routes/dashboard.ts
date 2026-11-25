/**
 * 统计看板：会话量、客户评价（好评 / 差评）、AI 质检，按天和按客服汇总。
 * 口径和会话记录一致：本部门客服接待的、按会话开始时间落在时段内。
 * 好评 = 4~5 星，差评 = 1~2 星，3 星算中评。
 */
import type { FastifyInstance } from 'fastify'
import { HttpError, resolveDepartment } from '../auth'
import { query } from '../db'
import { deptProjectId } from '../members'

const MAX_DAYS = 93

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
      WHERE s.project_id = ? AND s.start_time BETWEEN ? AND ?${onlyAssessed ? ' AND m.participate = 1 AND m.active = 1' : ''}`
    const params = [dept.id, projectId, begin, end]
    const agg = `
      COUNT(*) sessions,
      SUM(s.source = 'wg') wg,
      SUM(s.user_msg_count > 0) spoke,
      SUM(s.star_score > 0) reviewed,
      SUM(s.star_score) star_sum,
      SUM(s.star_score >= 4) good,
      SUM(s.star_score = 3) mid,
      SUM(s.star_score BETWEEN 1 AND 2) bad,
      COUNT(sc.session_id) ai_count,
      SUM(sc.total_score) ai_sum,
      SUM(sc.grade IN ('优秀', '良好')) ai_good`

    type Agg = { wg: number; sessions: number; spoke: number; reviewed: number; star_sum: number; good: number; mid: number; bad: number; ai_count: number; ai_sum: number; ai_good: number }
    const shape = (a: Agg): Record<string, number | null> => {
      const reviewed = Number(a.reviewed || 0)
      const aiCount = Number(a.ai_count || 0)
      return {
        sessions: Number(a.sessions || 0),
        wg: Number(a.wg || 0),
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
        summary: shape(summary),
        daily: daily.map((d) => ({ date: d.day, ...shape(d) })),
        byMember: byMember.map((m) => ({ sysUserId: Number(m.uid), name: m.name, participate: !!m.participate && !!m.active, ...shape(m) })),
        grades: grades.map((g) => ({ grade: g.grade, count: Number(g.n) }))
      }
    }
  })
}
