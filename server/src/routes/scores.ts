/**
 * AI 质检接口：单个评分、复核标记、批量评分（预览 / 开始 / 进度 / 取消）、部门的质检配置。
 */
import type { FastifyInstance } from 'fastify'
import { audit, HttpError, resolveDepartment } from '../auth'
import { execute, now, query } from '../db'
import { BATCH_ELIGIBLE, filterSql, parseFilter, SESSION_FROM } from '../sessions-filter'
import { getDeptSetting, isSectionConfigured } from '../settings'
import { defaultQuality, getQuality, normalizeDimensions, saveQuality } from '../ai/config'
import { BATCH_MAX, BatchBusyError, batchStatus, cancelBatch, getScore, scoreOne, scoreView, startBatch } from '../ai/service'
import { deptScope } from './sessions'

export async function scoreRoutes(app: FastifyInstance): Promise<void> {
  /** 给一个会话评分（同步等结果，一般十几秒到一分钟） */
  app.post('/api/sessions/:sessionId/score', async (req) => {
    const { dept, projectId } = await deptScope(req)
    if (!projectId) throw new HttpError(400, '本部门还没有填 SaleSmartly 项目')
    const sessionId = (req.params as { sessionId: string }).sessionId
    try {
      const row = await scoreOne(dept, projectId, sessionId, req.user!.username)
      return { success: true, data: scoreView(row) }
    } catch (err) {
      throw new HttpError(400, `评分失败：${(err as Error).message}`)
    }
  })

  /** 标记 / 取消「已人工复核」 */
  app.post('/api/sessions/:sessionId/review', async (req) => {
    const { dept, projectId } = await deptScope(req)
    const sessionId = (req.params as { sessionId: string }).sessionId
    const reviewed = !!(req.body as { reviewed?: boolean } | undefined)?.reviewed
    const [own] = await query(`SELECT s.session_id ${SESSION_FROM} AND s.session_id = ?`, [dept.id, projectId, sessionId])
    if (!own) throw new HttpError(404, '会话不存在，或不是本部门客服接待的')
    const res = await execute(
      "UPDATE ai_scores SET reviewed = ?, reviewed_by = ?, reviewed_at = ? WHERE project_id = ? AND session_id = ? AND status = 'ok'",
      [reviewed ? 1 : 0, reviewed ? req.user!.username : '', reviewed ? now() : 0, projectId, sessionId]
    )
    if (!res.affectedRows) throw new HttpError(400, '这个会话还没有 AI 评分')
    await audit(req, reviewed ? 'score_review' : 'score_unreview', sessionId, null, dept.id)
    const row = await getScore(projectId, sessionId)
    return { success: true, data: row ? scoreView(row) : null }
  })

  /** 批量评分预览：按会话列表的筛选条件，算出会评多少个、跳过多少个 */
  app.post('/api/scores/batch/preview', async (req) => {
    const { dept, projectId } = await deptScope(req)
    if (!projectId) throw new HttpError(400, '本部门还没有填 SaleSmartly 项目')
    const { cond, params } = filterSql(parseFilter((req.body || {}) as Record<string, unknown>))
    const [c] = await query<{ total: number; eligible: number; scored: number; no_customer: number; not_assessed: number; group_skipped: number }>(
      `SELECT COUNT(*) total,
              SUM(${BATCH_ELIGIBLE}) eligible,
              SUM(sc.status = 'ok') scored,
              SUM(s.source = 'wg' AND (sc.session_id IS NULL OR sc.status <> 'ok')) group_skipped,
              SUM(s.source = 'ss' AND s.user_msg_count = 0 AND (sc.session_id IS NULL OR sc.status <> 'ok')) no_customer,
              SUM(s.source = 'ss' AND NOT (m.participate = 1 AND m.active = 1) AND s.user_msg_count > 0 AND (sc.session_id IS NULL OR sc.status <> 'ok')) not_assessed
       ${SESSION_FROM}${cond}`,
      [dept.id, projectId, ...params]
    )
    const [tok] = await query<{ avg: number | null; n: number }>(
      "SELECT AVG(tokens_in + tokens_out) avg, COUNT(*) n FROM ai_scores WHERE department_id = ? AND status = 'ok' AND tokens_in > 0",
      [dept.id]
    )
    const ai = await getDeptSetting(dept.code, 'ai')
    return {
      success: true,
      data: {
        total: Number(c?.total || 0),
        eligible: Number(c?.eligible || 0),
        scored: Number(c?.scored || 0),
        noCustomer: Number(c?.no_customer || 0),
        notAssessed: Number(c?.not_assessed || 0),
        groupSkipped: Number(c?.group_skipped || 0),
        avgTokens: tok?.n ? Math.round(Number(tok.avg || 0)) : 0,
        model: ai.model,
        aiConfigured: isSectionConfigured('ai', ai),
        max: BATCH_MAX
      }
    }
  })

  /** 开始批量评分（只评预览里的 eligible 那部分） */
  app.post('/api/scores/batch', async (req) => {
    const { dept, projectId } = await deptScope(req)
    if (!projectId) throw new HttpError(400, '本部门还没有填 SaleSmartly 项目')
    if (!isSectionConfigured('ai', await getDeptSetting(dept.code, 'ai'))) throw new HttpError(400, '本部门还没有配好 AI 接口')
    const { cond, params } = filterSql(parseFilter((req.body || {}) as Record<string, unknown>))
    const rows = await query<{ session_id: string; customer_name: string }>(
      `SELECT s.session_id, s.customer_name ${SESSION_FROM}${cond} AND ${BATCH_ELIGIBLE} ORDER BY s.start_time DESC LIMIT ?`,
      [dept.id, projectId, ...params, BATCH_MAX + 1]
    )
    if (!rows.length) throw new HttpError(400, '这个范围里没有需要评分的会话')
    if (rows.length > BATCH_MAX) throw new HttpError(400, `一次最多评 ${BATCH_MAX} 个，请缩小日期范围或加筛选条件`)
    try {
      const job = startBatch(dept, projectId, rows.map((r) => ({ sessionId: r.session_id, customerName: r.customer_name })), req.user!.username, 'manual')
      await audit(req, 'score_batch', dept.code, { count: rows.length, jobId: job.id }, dept.id)
      return { success: true, data: job }
    } catch (err) {
      throw new HttpError(err instanceof BatchBusyError ? 409 : 400, (err as Error).message)
    }
  })

  app.get('/api/scores/batch', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    return { success: true, data: batchStatus(dept.code) }
  })

  app.post('/api/scores/batch/cancel', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    if (!cancelBatch(dept.code)) throw new HttpError(400, '没有正在进行的批量评分')
    await audit(req, 'score_batch_cancel', dept.code, null, dept.id)
    return { success: true }
  })

  // ─── 部门的 AI 质检配置 ───────────────────────────────────

  app.get('/api/quality', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const q = await getQuality(dept)
    const def = defaultQuality(dept)
    // 带上默认值：页面上「恢复默认」只是把表单填回默认，点保存才生效
    return { success: true, data: { ...q, defaults: { prompt: def.prompt, dimensions: def.dimensions } } }
  })

  app.put('/api/quality', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const body = (req.body || {}) as { prompt?: string; dimensions?: unknown; autoNightly?: boolean }
    const prompt = String(body.prompt ?? '').trim()
    if (prompt.length < 50) throw new HttpError(400, '提示词太短了，要写清楚评分标准')
    if (prompt.length > 30000) throw new HttpError(400, '提示词太长（最多 3 万字）')
    let dimensions
    try {
      dimensions = normalizeDimensions(body.dimensions)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    const before = (await getQuality(dept)).value
    const value = { prompt, dimensions, autoNightly: !!body.autoNightly }
    await saveQuality(dept, value, req.user!.username)
    await audit(req, 'quality_update', dept.code, {
      promptChanged: before.prompt !== prompt,
      dimensions,
      autoNightly: value.autoNightly
    }, dept.id)
    return { success: true, data: await getQuality(dept) }
  })
}
