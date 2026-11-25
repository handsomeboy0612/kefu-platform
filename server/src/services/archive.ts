/**
 * 企业微信群聊归档服务（archive-server，和平台在同一台机器上）。
 * 这一步只有测试连接；对公群同步在后面搬过来。
 */
import type { ArchiveSettings } from '../settings'
import { describeFetchError } from './salesmartly'

/** 采集端超过这么久没上传，就算离线 */
const AGENT_OFFLINE_SEC = 30 * 60

export interface ArchiveHealth {
  ok: boolean
  store_ready: boolean
  server_time: number
  msg_total: number
  groups: number
  agents: Array<{
    agent_name: string
    agent_id: string
    corp_name: string
    last_upload_at: number
    last_msg_at: number
    msg_total: number
  }>
}

/** GET /api/v1/archive{path}，统一处理 401 / 503 / 业务错误 */
export async function archiveGet<T>(
  cfg: ArchiveSettings,
  path: string,
  params?: Record<string, string | number>
): Promise<T> {
  if (!cfg.serverUrl) throw new Error('还没有配置归档服务地址')
  const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : ''
  const res = await fetch(`${cfg.serverUrl}/api/v1/archive${path}${qs}`, {
    headers: cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {},
    signal: AbortSignal.timeout(30_000)
  })
  if (res.status === 401) throw new Error('API Key 错误（归档服务返回 401）')
  if (res.status === 503) throw new Error('归档服务的数据库还没准备好（503），稍后再试')
  let body: { success?: boolean; data?: T; error?: string } | null = null
  try { body = await res.json() } catch { /* 下面统一报错 */ }
  if (res.status !== 200 || !body?.success) throw new Error(body?.error || `归档服务返回 HTTP ${res.status}`)
  return body.data as T
}

/** 测试连接：报消息量、群数和各采集端（机器人）是否在线 */
export async function testArchive(cfg: ArchiveSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const h = await archiveGet<ArchiveHealth>(cfg, '/health')
    if (!h.store_ready) return { ok: false, message: '归档服务的数据库还没准备好' }
    const agents = (h.agents || [])
      .map((a) => `${a.agent_name}${h.server_time - (a.last_upload_at || 0) > AGENT_OFFLINE_SEC ? '（离线）' : ''}`)
      .join('、')
    return { ok: true, message: `连接成功，已归档 ${h.msg_total} 条消息、${h.groups} 个群；采集端：${agents || '暂无'}` }
  } catch (err) {
    return { ok: false, message: describeFetchError(err) }
  }
}
