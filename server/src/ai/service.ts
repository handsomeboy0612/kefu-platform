/**
 * AI 质检的业务逻辑：给一个会话打分并入库、批量评分任务、每晚自动评分。
 */
import { execute, now, query } from '../db'
import { listDepartments, type Department } from '../auth'
import { getDeptSetting, isSectionConfigured } from '../settings'
import { deptProjectId } from '../members'
import { SalesmartlyClient } from '../services/salesmartly'
import { fetchSessionMessages } from '../sync/salesmartly-sync'
import { BATCH_ELIGIBLE, SESSION_FROM } from '../sessions-filter'
import { getQuality } from './config'
import { AIConfigError, scoreConversation, type ScoreMessage } from './score'
import { writeGradeSafe } from './tag-writeback'

export interface ScoreRow {
  status: 'ok' | 'failed'
  total_score: string | number | null
  grade: string
  dimensions: unknown
  highlights: unknown
  issues: unknown
  summary: string | null
  improvement: string | null
  raw: unknown
  error: string | null
  model: string
  scored_by: string
  scored_at: number
  reviewed: number
  reviewed_by: string
  reviewed_at: number
}

const json = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T } catch { return fallback }
  }
  return v as T
}

export function scoreView(r: ScoreRow): Record<string, unknown> {
  return {
    status: r.status,
    total: r.total_score == null ? null : Number(r.total_score),
    grade: r.grade,
    dimensions: json(r.dimensions, [] as unknown[]),
    highlights: json(r.highlights, [] as string[]),
    issues: json(r.issues, [] as string[]),
    summary: r.summary || '',
    improvement: r.improvement || '',
    raw: json(r.raw, null),
    error: r.error || '',
    model: r.model,
    scoredBy: r.scored_by,
    scoredAt: Number(r.scored_at),
    reviewed: !!r.reviewed,
    reviewedBy: r.reviewed_by,
    reviewedAt: Number(r.reviewed_at)
  }
}

export async function getScore(projectId: string, sessionId: string): Promise<ScoreRow | null> {
  const [r] = await query<ScoreRow>('SELECT * FROM ai_scores WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
  return r ?? null
}

/**
 * 给一个会话打分并入库。会话必须是这个部门客服接待的（调用方已经校验或在这里校验）。
 * 失败时：以前评成功过的保留旧分数；从没评成功过的记一条 failed。
 */
export async function scoreOne(dept: Department, projectId: string, sessionId: string, by: string): Promise<ScoreRow> {
  const [s] = await query<{ start_time: number; end_time: number; assign_time: number; star_score: number; msgs_synced: number }>(
    `SELECT s.start_time, s.end_time, s.assign_time, s.star_score, s.msgs_synced ${SESSION_FROM} AND s.session_id = ?`,
    [dept.id, projectId, sessionId]
  )
  if (!s) throw new Error('会话不存在，或不是本部门客服接待的')

  try {
    const ssCfg = await getDeptSetting(dept.code, 'salesmartly')
    if (!s.msgs_synced) await fetchSessionMessages(new SalesmartlyClient(ssCfg), projectId, sessionId)
    const msgs = await query<{ sender_type: ScoreMessage['senderType']; sender_name: string; content: string; send_time: number; image_url: string; recalled: number }>(
      'SELECT sender_type, sender_name, content, send_time, image_url, recalled FROM ss_messages WHERE project_id = ? AND session_id = ? ORDER BY send_time, id',
      [projectId, sessionId]
    )
    const quality = (await getQuality(dept)).value
    const ai = await getDeptSetting(dept.code, 'ai')
    const r = await scoreConversation(
      {
        messages: msgs.map((m) => ({
          senderType: m.sender_type, senderName: m.sender_name, content: m.content,
          sendTime: Number(m.send_time), imageUrl: m.image_url, recalled: !!m.recalled
        })),
        serviceBeginTime: Number(s.assign_time || s.start_time),
        endTime: Number(s.end_time),
        starScore: s.star_score
      },
      quality,
      ai
    )
    await execute(
      `INSERT INTO ai_scores (project_id, session_id, department_id, status, total_score, grade, dimensions, highlights, issues,
         summary, improvement, raw, error, model, prompt_hash, tokens_in, tokens_out, scored_by, scored_at, reviewed, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, 'ok', ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, ?, CAST(? AS JSON), NULL, ?, ?, ?, ?, ?, ?, 0, '', 0)
       ON DUPLICATE KEY UPDATE department_id = VALUES(department_id), status = 'ok', total_score = VALUES(total_score), grade = VALUES(grade),
         dimensions = VALUES(dimensions), highlights = VALUES(highlights), issues = VALUES(issues), summary = VALUES(summary),
         improvement = VALUES(improvement), raw = VALUES(raw), error = NULL, model = VALUES(model), prompt_hash = VALUES(prompt_hash),
         tokens_in = VALUES(tokens_in), tokens_out = VALUES(tokens_out), scored_by = VALUES(scored_by), scored_at = VALUES(scored_at),
         reviewed = 0, reviewed_by = '', reviewed_at = 0`,
      [projectId, sessionId, dept.id, r.total, r.grade, JSON.stringify(r.dimensions), JSON.stringify(r.highlights), JSON.stringify(r.issues),
        r.summary, r.improvement, JSON.stringify(r.raw), r.model.slice(0, 64), r.promptHash, r.tokensIn, r.tokensOut, by || 'auto', now()]
    )
    writeGradeSafe(ssCfg, sessionId, r.grade)
  } catch (err) {
    const msg = (err as Error).message || String(err)
    await execute(
      `INSERT INTO ai_scores (project_id, session_id, department_id, status, error, scored_by, scored_at)
       VALUES (?, ?, ?, 'failed', ?, ?, ?)
       ON DUPLICATE KEY UPDATE error = IF(status = 'ok', error, VALUES(error)), scored_at = IF(status = 'ok', scored_at, VALUES(scored_at))`,
      [projectId, sessionId, dept.id, msg.slice(0, 2000), by || 'auto', now()]
    )
    throw err
  }
  return (await getScore(projectId, sessionId))!
}

// ─── 批量评分任务（每个部门同时只跑一个） ──────────────────────────────

export interface BatchJob {
  id: number
  deptCode: string
  kind: 'manual' | 'nightly'
  by: string
  total: number
  done: number
  ok: number
  failed: number
  startedAt: number
  finishedAt: number
  cancelled: boolean
  /** 遇到配置问题（Key 无效等）自动停下时的原因 */
  abortReason: string
  errors: Array<{ sessionId: string; customerName: string; error: string }>
}

const CONCURRENCY = 5
export const BATCH_MAX = 5000
const jobs = new Map<string, BatchJob>()
let jobSeq = 0

export const batchStatus = (deptCode: string): BatchJob | null => jobs.get(deptCode) ?? null

export class BatchBusyError extends Error {}

export function startBatch(dept: Department, projectId: string, targets: Array<{ sessionId: string; customerName: string }>, by: string, kind: BatchJob['kind']): BatchJob {
  const cur = jobs.get(dept.code)
  if (cur && !cur.finishedAt) throw new BatchBusyError('本部门已经有一个批量评分在跑，等它跑完或先取消')
  const job: BatchJob = {
    id: ++jobSeq, deptCode: dept.code, kind, by, total: targets.length, done: 0, ok: 0, failed: 0,
    startedAt: now(), finishedAt: 0, cancelled: false, abortReason: '', errors: []
  }
  jobs.set(dept.code, job)
  const queue = [...targets]
  void (async () => {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length && !job.cancelled) {
        const t = queue.shift()!
        try {
          await scoreOne(dept, projectId, t.sessionId, by)
          job.ok++
        } catch (err) {
          job.failed++
          if (job.errors.length < 30) job.errors.push({ ...t, error: (err as Error).message })
          // Key 无效 / 模型不存在：后面的也必然失败，还会被接口限流，直接停
          if (err instanceof AIConfigError && !job.abortReason) {
            job.abortReason = (err as Error).message
            job.cancelled = true
          }
        }
        job.done++
      }
    }))
    job.finishedAt = now()
    console.log(`[ai] ${dept.name} ${kind === 'nightly' ? '每晚自动' : '批量'}评分结束：成功 ${job.ok}，失败 ${job.failed}${job.abortReason ? `（自动停止：${job.abortReason}）` : job.cancelled ? '（已取消）' : ''}`)
  })()
  return job
}

export function cancelBatch(deptCode: string): boolean {
  const job = jobs.get(deptCode)
  if (!job || job.finishedAt) return false
  job.cancelled = true
  return true
}

// ─── 每晚 01:00 自动评前一天的 ──────────────────────────────────────

async function nightlyOnce(): Promise<void> {
  const today = new Date()
  const end = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000)
  const begin = end - 86400
  for (const dept of await listDepartments()) {
    try {
      const q = await getQuality(dept)
      if (!q.value.autoNightly) continue
      if (!isSectionConfigured('ai', await getDeptSetting(dept.code, 'ai'))) continue
      const projectId = await deptProjectId(dept)
      if (!projectId) continue
      const rows = await query<{ session_id: string; customer_name: string }>(
        `SELECT s.session_id, s.customer_name ${SESSION_FROM} AND s.start_time >= ? AND s.start_time < ? AND ${BATCH_ELIGIBLE}
         ORDER BY s.start_time LIMIT ?`,
        [dept.id, projectId, begin, end, BATCH_MAX]
      )
      if (!rows.length) continue
      startBatch(dept, projectId, rows.map((r) => ({ sessionId: r.session_id, customerName: r.customer_name })), 'auto', 'nightly')
      console.log(`[ai] ${dept.name} 每晚自动评分开始：${rows.length} 个会话`)
    } catch (err) {
      console.error(`[ai] ${dept.name} 每晚自动评分没能开始：${(err as Error).message}`)
    }
  }
}

/** 每天 01:00（北京时间，进程时区已设好）跑一次 */
export function startNightlyScheduler(): void {
  const schedule = (): void => {
    const n = new Date()
    const next = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 1, 0, 0)
    if (next.getTime() <= n.getTime()) next.setDate(next.getDate() + 1)
    setTimeout(() => {
      nightlyOnce().catch((e) => console.error('[ai] 每晚自动评分出错', e)).finally(schedule)
    }, next.getTime() - n.getTime())
  }
  schedule()
}
