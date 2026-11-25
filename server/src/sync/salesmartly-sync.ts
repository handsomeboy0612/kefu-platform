/**
 * SaleSmartly 会话同步。
 *
 * - 按项目同步：两个部门填的是同一个项目就只拉一次，会话存一份，部门按负责客服所在部门看
 * - 自动：每小时一次，重拉最近 3 天开始的已结束会话（进行中的会话结束后、客户事后补的评价都能补上）；
 *   这个项目第一次同步时从本月 1 号拉起
 * - 手动：页面上选时间段「立即同步」
 * - 每次先刷新成员名单，再拉会话，最后补拉聊天记录（客户发过言、还没拉过的）
 * - 同一个项目同时只跑一个同步
 */
import { execute, now, query, transaction } from '../db'
import { listDepartments, type Department } from '../auth'
import { getDeptSetting, isSectionConfigured, type SalesmartlySettings } from '../settings'
import { pullMembers } from '../members'
import { describeFetchError, SalesmartlyClient, type SsSession } from '../services/salesmartly'
import { normalizeMessage, type MessageRow } from './normalize'

const AUTO_INTERVAL_MS = 60 * 60 * 1000
const AUTO_LOOKBACK_SEC = 3 * 86400
const MSG_CONCURRENCY = 4
const MSG_MAX_FAIL = 3

export interface SyncProgress {
  runId: number
  phase: 'members' | 'sessions' | 'messages'
  done: number
  total: number
  startedAt: number
}

const running = new Map<string, SyncProgress>()

export const syncProgress = (projectId: string): SyncProgress | null => running.get(projectId) ?? null

interface ProjectTarget {
  projectId: string
  dept: Department
  cfg: SalesmartlySettings
}

/** 填了 SaleSmartly 的部门，按项目去重（同一项目取第一个部门的 Token） */
export async function syncTargets(): Promise<ProjectTarget[]> {
  const out = new Map<string, ProjectTarget>()
  for (const dept of await listDepartments()) {
    const cfg = await getDeptSetting(dept.code, 'salesmartly')
    if (!isSectionConfigured('salesmartly', cfg) || out.has(cfg.projectId)) continue
    out.set(cfg.projectId, { projectId: cfg.projectId, dept, cfg })
  }
  return [...out.values()]
}

/** 这个部门对应的同步目标（用它自己的 Token） */
export async function targetForDept(dept: Department): Promise<ProjectTarget> {
  const cfg = await getDeptSetting(dept.code, 'salesmartly')
  if (!isSectionConfigured('salesmartly', cfg)) throw new Error('本部门还没有填 SaleSmartly 项目 ID 和 API Token')
  return { projectId: cfg.projectId, dept, cfg }
}

async function staffNameMap(projectId: string): Promise<Map<string, string>> {
  const rows = await query<{ sys_user_id: number; nickname: string; email: string }>(
    'SELECT sys_user_id, nickname, email FROM members WHERE project_id = ?', [projectId]
  )
  return new Map(rows.map((r) => [String(r.sys_user_id), r.nickname || r.email || String(r.sys_user_id)]))
}

/** 会话批量入库，返回其中新增的条数 */
async function upsertSessions(projectId: string, list: SsSession[]): Promise<number> {
  const uniq = new Map<string, SsSession>()
  for (const s of list) if (s.session_id) uniq.set(s.session_id, s)
  const all = [...uniq.values()]
  let added = 0
  const t = now()
  for (let i = 0; i < all.length; i += 200) {
    const batch = all.slice(i, i + 200)
    const ids = batch.map((s) => s.session_id)
    const exist = await query<{ session_id: string }>(
      'SELECT session_id FROM ss_sessions WHERE project_id = ? AND session_id IN (?)', [projectId, ids]
    )
    added += batch.length - exist.length
    const values = batch.map((s) => [
      projectId, s.session_id, (s.chat_user_id || '').slice(0, 128), (s.title || '').slice(0, 255), s.sys_user_id || 0,
      s.channel || 0, s.channel_id || 0, s.start_time || 0, s.end_time || 0, s.assign_time || 0,
      s.score || 0, s.quality_score || 0, s.tags || '', s.msg_count || 0, s.user_msg_count || 0, s.customer_msg_count || 0, t
    ])
    await execute(
      `INSERT INTO ss_sessions (project_id, session_id, chat_user_id, customer_name, sys_user_id, channel, channel_id,
         start_time, end_time, assign_time, star_score, quality_score, tags, msg_count, user_msg_count, kf_msg_count, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         -- 消息数变了（会话又有新消息）就重新拉聊天记录；这两句必须写在 msg_count 更新之前，MySQL 按顺序赋值
         msgs_synced = IF(msg_count <> VALUES(msg_count), 0, msgs_synced),
         msg_fail = IF(msg_count <> VALUES(msg_count), 0, msg_fail),
         chat_user_id = VALUES(chat_user_id), customer_name = VALUES(customer_name),
         sys_user_id = VALUES(sys_user_id), channel = VALUES(channel), channel_id = VALUES(channel_id),
         start_time = VALUES(start_time), end_time = VALUES(end_time), assign_time = VALUES(assign_time),
         star_score = VALUES(star_score), quality_score = VALUES(quality_score), tags = VALUES(tags),
         msg_count = VALUES(msg_count), user_msg_count = VALUES(user_msg_count), kf_msg_count = VALUES(kf_msg_count),
         synced_at = VALUES(synced_at)`,
      [values]
    )
  }
  return added
}

const isDeadlock = (err: unknown): boolean => (err as { errno?: number }).errno === 1213 || (err as { errno?: number }).errno === 1205

/** 把一个会话的聊天记录整段替换成新的。并发写偶尔死锁，自动重试 */
async function saveMessages(projectId: string, sessionId: string, rows: MessageRow[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await saveMessagesOnce(projectId, sessionId, rows)
    } catch (err) {
      if (!isDeadlock(err) || attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200 * (attempt + 1)))
    }
  }
}

async function saveMessagesOnce(projectId: string, sessionId: string, rows: MessageRow[]): Promise<void> {
  await transaction(async (conn) => {
    await conn.query('DELETE FROM ss_messages WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
    if (rows.length) {
      await conn.query(
        `INSERT INTO ss_messages (project_id, session_id, mid, sender_type, sender_name, content, msg_type, send_time, image_url, recalled)
         VALUES ?`,
        [rows.map((r) => [projectId, sessionId, r.mid, r.senderType, r.senderName.slice(0, 128), r.content, r.msgType, r.sendTime, r.imageUrl, r.recalled])]
      )
    }
    await conn.query('UPDATE ss_sessions SET msgs_synced = 1, msg_fail = 0 WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
  }, { readCommitted: true })
}

/** 拉一个会话的聊天记录并入库 */
export async function fetchSessionMessages(
  client: SalesmartlyClient,
  projectId: string,
  sessionId: string,
  staffNames?: Map<string, string>
): Promise<void> {
  const names = staffNames ?? (await staffNameMap(projectId))
  const [s] = await query<{ sys_user_id: number }>('SELECT sys_user_id FROM ss_sessions WHERE project_id = ? AND session_id = ?', [projectId, sessionId])
  const fallback = s ? names.get(String(s.sys_user_id)) || '' : ''
  const raw = await client.fetchMessagesBySession(sessionId)
  const rows = raw
    .map((m) => normalizeMessage(m, names, fallback))
    .filter((r): r is MessageRow => r !== null)
    .sort((a, b) => a.sendTime - b.sendTime)
  await saveMessages(projectId, sessionId, rows)
}

/** 补拉：客户发过言、还没拉过聊天记录、失败次数没到上限的会话 */
async function backfillMessages(client: SalesmartlyClient, projectId: string, progress: SyncProgress): Promise<{ ok: number; failed: number }> {
  const pending = await query<{ session_id: string }>(
    `SELECT session_id FROM ss_sessions
     WHERE project_id = ? AND msgs_synced = 0 AND user_msg_count > 0 AND msg_fail < ?
     ORDER BY start_time DESC`,
    [projectId, MSG_MAX_FAIL]
  )
  progress.phase = 'messages'
  progress.done = 0
  progress.total = pending.length
  const names = await staffNameMap(projectId)
  const queue = pending.map((p) => p.session_id)
  let ok = 0
  let failed = 0
  await Promise.all(Array.from({ length: Math.min(MSG_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()!
      try {
        await fetchSessionMessages(client, projectId, id, names)
        ok++
      } catch (err) {
        failed++
        await execute('UPDATE ss_sessions SET msg_fail = msg_fail + 1 WHERE project_id = ? AND session_id = ?', [projectId, id])
        console.warn(`[sync] 会话 ${id} 聊天记录拉取失败：${describeFetchError(err)}`)
      }
      progress.done++
    }
  }))
  return { ok, failed }
}

export class SyncBusyError extends Error {}

/**
 * 同步一个项目的一段时间（按会话开始时间）。
 * 立刻返回 runId，同步在后台跑；进度用 syncProgress(projectId) 查。
 */
export async function startSync(
  target: ProjectTarget,
  begin: number,
  end: number,
  trigger: 'auto' | 'manual',
  by: string
): Promise<number> {
  const { projectId, dept, cfg } = target
  if (running.has(projectId)) throw new SyncBusyError('这个 SaleSmartly 项目正在同步，等这次跑完再试')
  const startedAt = now()
  // 先占位，防止并发两次点击都通过上面的检查
  const progress: SyncProgress = { runId: 0, phase: 'members', done: 0, total: 0, startedAt }
  running.set(projectId, progress)
  try {
    const res = await execute(
      `INSERT INTO sync_runs (project_id, source, \`trigger\`, triggered_by, range_begin, range_end, status, started_at)
       VALUES (?, 'ss', ?, ?, ?, ?, 'running', ?)`,
      [projectId, trigger, by, begin, end, startedAt]
    )
    progress.runId = res.insertId
  } catch (err) {
    running.delete(projectId)
    throw err
  }

  void (async () => {
    const stat = { fetched: 0, added: 0, msgOk: 0, msgFail: 0 }
    let error: string | null = null
    try {
      const client = new SalesmartlyClient(cfg)
      await pullMembers(dept)
      progress.phase = 'sessions'
      const list = await client.fetchSessionsByRange(begin, end, (done, total) => {
        progress.done = done
        progress.total = total
      })
      stat.fetched = list.length
      stat.added = await upsertSessions(projectId, list)
      const m = await backfillMessages(client, projectId, progress)
      stat.msgOk = m.ok
      stat.msgFail = m.failed
    } catch (err) {
      error = describeFetchError(err)
      console.error(`[sync] 项目 ${projectId} 同步失败：${error}`)
    } finally {
      await execute(
        `UPDATE sync_runs SET status = ?, finished_at = ?, sessions_fetched = ?, sessions_new = ?,
           messages_synced = ?, messages_failed = ?, error = ? WHERE id = ?`,
        [error ? 'failed' : 'success', now(), stat.fetched, stat.added, stat.msgOk, stat.msgFail, error, progress.runId]
      ).catch((e) => console.error('[sync] 写同步记录失败', e))
      running.delete(projectId)
      console.log(`[sync] 项目 ${projectId} ${trigger} 同步结束：会话 ${stat.fetched}（新 ${stat.added}），聊天记录 ${stat.msgOk}，失败 ${stat.msgFail}${error ? `，错误：${error}` : ''}`)
    }
  })()

  return progress.runId
}

/** 本月 1 号 0 点（北京时间，进程时区已设为 Asia/Shanghai） */
function monthStart(): number {
  const d = new Date()
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000)
}

/** 自动同步一轮：每个项目各跑一次 */
async function autoSyncOnce(): Promise<void> {
  for (const target of await syncTargets()) {
    if (running.has(target.projectId)) continue
    const [done] = await query<{ n: number }>(
      "SELECT COUNT(*) n FROM sync_runs WHERE project_id = ? AND source = 'ss' AND status = 'success'", [target.projectId]
    )
    const end = now()
    const begin = Number(done?.n) > 0 ? end - AUTO_LOOKBACK_SEC : monthStart()
    try {
      await startSync(target, begin, end, 'auto', '')
    } catch (err) {
      console.error(`[sync] 项目 ${target.projectId} 自动同步没能开始：${(err as Error).message}`)
    }
  }
}

/** 启动定时同步：先把上次进程退出时没跑完的记录标成中断，1 分钟后跑第一轮，之后每小时一轮 */
export async function startScheduler(): Promise<void> {
  await execute(
    "UPDATE sync_runs SET status = 'failed', finished_at = ?, error = '平台重启，这次同步被中断（下一轮会补上）' WHERE status = 'running'",
    [now()]
  )
  const tick = (): void => { autoSyncOnce().catch((e) => console.error('[sync] 自动同步出错', e)) }
  setTimeout(tick, 60 * 1000)
  setInterval(tick, AUTO_INTERVAL_MS)
}
