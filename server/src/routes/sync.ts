/**
 * 同步状态和手动同步。按部门请求，实际作用在部门填的 SaleSmartly 项目上
 * （两个部门同一个项目时，看到的是同一份同步记录）。
 */
import type { FastifyInstance } from 'fastify'
import { audit, HttpError, resolveDepartment } from '../auth'
import { query } from '../db'
import { deptProjectId } from '../members'
import { startSync, SyncBusyError, syncProgress, targetForDept } from '../sync/salesmartly-sync'

const MAX_MANUAL_DAYS = 62

interface RunRow {
  id: number
  trigger: string
  triggered_by: string
  range_begin: number
  range_end: number
  status: string
  started_at: number
  finished_at: number
  sessions_fetched: number
  sessions_new: number
  messages_synced: number
  messages_failed: number
  error: string | null
}

const runView = (r: RunRow): Record<string, unknown> => ({
  id: r.id,
  trigger: r.trigger,
  triggeredBy: r.triggered_by,
  rangeBegin: Number(r.range_begin),
  rangeEnd: Number(r.range_end),
  status: r.status,
  startedAt: Number(r.started_at),
  finishedAt: Number(r.finished_at),
  sessionsFetched: r.sessions_fetched,
  sessionsNew: r.sessions_new,
  messagesSynced: r.messages_synced,
  messagesFailed: r.messages_failed,
  error: r.error
})

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sync/status', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const projectId = await deptProjectId(dept)
    if (!projectId) return { success: true, data: { projectId: '', progress: null, lastSuccess: null, runs: [] } }
    const runs = await query<RunRow>(
      "SELECT * FROM sync_runs WHERE project_id = ? AND source = 'ss' ORDER BY id DESC LIMIT 15", [projectId]
    )
    const [last] = await query<RunRow>(
      "SELECT * FROM sync_runs WHERE project_id = ? AND source = 'ss' AND status = 'success' ORDER BY finished_at DESC LIMIT 1", [projectId]
    )
    const [pending] = await query<{ n: number }>(
      'SELECT COUNT(*) n FROM ss_sessions WHERE project_id = ? AND msgs_synced = 0 AND user_msg_count > 0 AND msg_fail >= 3', [projectId]
    )
    return {
      success: true,
      data: {
        projectId,
        autoIntervalMin: 60,
        progress: syncProgress(projectId),
        lastSuccess: last ? runView(last) : null,
        runs: runs.map(runView),
        /** 聊天记录连续拉失败 3 次、不再自动重试的会话数（点开会话时会再拉一次） */
        messagesGivenUp: Number(pending?.n || 0)
      }
    }
  })

  /** 手动同步一段时间（按会话开始时间），最长 62 天 */
  app.post('/api/sync/run', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const body = (req.body || {}) as { begin?: number; end?: number }
    const begin = Math.trunc(Number(body.begin))
    const end = Math.trunc(Number(body.end))
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end) throw new HttpError(400, '请选择时间段')
    if (end - begin > MAX_MANUAL_DAYS * 86400) throw new HttpError(400, `一次最多同步 ${MAX_MANUAL_DAYS} 天`)
    let runId: number
    try {
      runId = await startSync(await targetForDept(dept), begin, end, 'manual', req.user!.username)
    } catch (err) {
      throw new HttpError(err instanceof SyncBusyError ? 409 : 400, (err as Error).message)
    }
    await audit(req, 'sync_manual', dept.code, { begin, end, runId }, dept.id)
    return { success: true, data: { runId } }
  })
}
