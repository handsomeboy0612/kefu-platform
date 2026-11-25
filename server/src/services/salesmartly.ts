/**
 * SaleSmartly 开放平台客户端（从桌面版搬过来，axios 换成 Node 自带的 fetch）。
 *
 * 鉴权（官方文档 https://help.salesmartly.com/docs/API-Header）：
 * 1. 本次请求的所有参数按参数名字典序升序，拼成 key=value&key2=value2
 * 2. 前面拼上项目 API Token：`TOKEN&key=value&key2=value2`
 * 3. 整串 MD5（32 位小写十六进制）放进请求头 external-sign
 */
import { createHash } from 'crypto'
import { getDeptSetting, type SalesmartlySettings } from '../settings'

const BASE_URL = 'https://developer.salesmartly.com'

interface SsResponse<T = unknown> {
  code: number
  msg: string
  request_id?: string
  data: T
}

export interface SsMember {
  id: number
  project_id: string
  sys_user_id: number
  type: number
  identity_id: number
  identity_name: string
  nickname: string
  email: string
  avatar: string
  online_status: number // 0-离线 1-在线 2-忙碌
  is_del: number
  groups: Array<{ group_id: number; group_name: string }>
}

/** 会话列表条目（/api/v2/get-session-list） */
export interface SsSession {
  chat_user_id: string
  session_id: string // Disorder 加密的小写字符串；进行中的会话可能没有
  channel: number
  channel_id: number
  title: string // 客户名称
  start_time: number // 秒
  end_time: number // 秒，进行中为 0
  assign_time: number
  score: number // 满意度星级，0 = 未评价
  quality_score: number
  sys_user_id: number // 负责客服
  tags: string
  msg_count: number
  user_msg_count: number // 客户消息数
  customer_msg_count: number // 注意：官方语义是「客服消息数」
}

/** 聊天消息（/api/v2/get-all-message-list） */
export interface SsMessage {
  chat_user_id: string
  sequence_id: number
  is_system: number // 实测恒为 -1，不能用来判断机器人
  send_time: number
  sender: string // 团队成员是 sys_user_id，客户是哈希串
  sender_type: number // 1-用户 2-团队成员 3-系统
  mid: string
  msg_type: number
  text: string
  is_withdraw: number
  content: string // 整条消息的 JSON 负载
}

/** 大报表行（/api/v2/get-big-report，group_by=sys_user_id） */
export interface SsReportRow {
  sys_user_id: number
  nickname: string
  email: string
  start_session_pv: number // 分配会话数
  avg_fst_replay_time: number // 首次响应时长均值（秒）
  avg_replay_time: number // 响应时长均值（秒）
  is_invit_pv: number // 邀评会话数
  is_score_pv: number // 参评会话数
  sum_score: number // 满意度总分（5 星制）
  fst_reply_session_cnt: number // 首次响应会话数
}

/** 在线时长报表行（秒） */
export interface SsOnlineRow {
  sys_user_id: number
  login_duration: number
  online_duration: number
  busy_duration: number
}

/** 响应码 → 看得懂的提示（见官方响应码文档） */
const ERROR_HINTS: Record<number, string> = {
  100: 'API Token 无效，请检查是否与 SaleSmartly 后台一致',
  101: '访问令牌无效，请重新获取',
  102: '签名校验失败（external-sign 不正确）',
  103: '请求频率超限，请稍后重试',
  400: '请求参数有误'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 全局节流：平台 QPS 上限 20，而且是账号级共享的——两个部门的桌面版、内网那个分析工作台也在用同一个项目。
 * 平台这边只用 120ms 一次（约 8 QPS），给别人留出余量。放在模块级，所有调用方加起来也不超。
 */
const MIN_INTERVAL_MS = 120
let nextSlotAt = 0
async function throttle(): Promise<void> {
  const t = Date.now()
  const wait = Math.max(0, nextSlotAt - t)
  nextSlotAt = Math.max(t, nextSlotAt) + MIN_INTERVAL_MS
  if (wait > 0) await sleep(wait)
}

/** 频率超限（code=103）的错误，调用方可以退避重试 */
export class RateLimitError extends Error {}

function sign(params: Record<string, string | number>, token: string): string {
  const q = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
  return createHash('md5').update(`${token}&${q}`, 'utf8').digest('hex')
}

export class SalesmartlyClient {
  constructor(private readonly cfg: Pick<SalesmartlySettings, 'projectId' | 'apiToken'>) {
    if (!cfg.apiToken || !cfg.projectId) {
      throw new Error('还没有填写 SaleSmartly 项目 ID 或 API Token，请到「设置 → 数据源与 AI」填写')
    }
  }

  private async handle<T>(path: string, res: Response): Promise<T> {
    // 鉴权失败时是 HTTP 401 + JSON（code=102 签名不对等），先读 body 才能给出具体原因
    let body: SsResponse<T> | null = null
    try { body = (await res.json()) as SsResponse<T> } catch { /* 不是 JSON */ }
    if (!body || typeof body.code !== 'number') throw new Error(`SaleSmartly 接口 HTTP ${res.status}（${path}）`)
    if (body.code === 102) {
      throw new Error('签名校验失败：API Token 和项目 ID 对不上，请核对这两项是否来自同一个 SaleSmartly 项目')
    }
    if (body.code === 103) throw new RateLimitError(ERROR_HINTS[103])
    if (body.code !== 0) {
      const hint = ERROR_HINTS[body.code] || body.msg || '未知错误'
      throw new Error(`SaleSmartly 接口错误（code=${body.code}）：${hint}`)
    }
    return body.data
  }

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const full: Record<string, string | number> = { project_id: this.cfg.projectId, ...params }
    const qs = new URLSearchParams(Object.entries(full).map(([k, v]) => [k, String(v)]))
    // 频率超限时退避重试（2s → 4s → 8s），别的错误直接抛
    for (let attempt = 0; ; attempt++) {
      await throttle()
      const res = await fetch(`${BASE_URL}${path}?${qs}`, {
        headers: { 'external-sign': sign(full, this.cfg.apiToken) },
        signal: AbortSignal.timeout(30_000)
      })
      try {
        return await this.handle<T>(path, res)
      } catch (err) {
        if (!(err instanceof RateLimitError) || attempt >= 3) throw err
        await sleep(2000 * 2 ** attempt)
      }
    }
  }

  /** POST（multipart/form-data），参与签名的是全部表单字段（含 project_id） */
  async post<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    await throttle()
    const full: Record<string, string | number> = { project_id: this.cfg.projectId, ...params }
    const form = new FormData()
    for (const [k, v] of Object.entries(full)) form.append(k, String(v))
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      body: form,
      headers: { 'external-sign': sign(full, this.cfg.apiToken) },
      signal: AbortSignal.timeout(30_000)
    })
    return this.handle<T>(path, res)
  }

  /** 全部团队成员（自动翻页，去掉已删除的） */
  async getAllMembers(): Promise<SsMember[]> {
    const members: SsMember[] = []
    for (let page = 1; ; page++) {
      const data = await this.get<{ list: SsMember[]; total: number }>('/api/v2/get-member-list', { page, page_size: 100 })
      members.push(...(data.list || []))
      if (members.length >= (data.total ?? 0) || (data.list || []).length === 0) break
    }
    return members.filter((m) => !m.is_del)
  }

  /**
   * 按会话开始时间拉一段时间内已结束的会话（先拿第一页的 total，后面 3 路并发翻页）。
   * 翻页期间有新会话结束可能造成页间重复，入库按 session_id 去重，没影响。
   */
  async fetchSessionsByRange(begin: number, end: number, onProgress?: (fetched: number, total: number) => void): Promise<SsSession[]> {
    const pageSize = 100
    const fetchPage = (page: number): Promise<{ list: SsSession[]; total: number }> =>
      this.get('/api/v2/get-session-list', {
        page,
        page_size: pageSize,
        session_status: 1,
        start_time: JSON.stringify({ start: begin, end }),
        sort_field: 'created_time',
        sort_order: 'desc'
      })
    const first = await fetchPage(1)
    const total = first.total ?? (first.list || []).length
    const out: SsSession[] = [...(first.list || [])]
    onProgress?.(out.length, total)
    const queue: number[] = []
    for (let p = 2; p <= Math.ceil(total / pageSize); p++) queue.push(p)
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const data = await fetchPage(queue.shift()!)
        out.push(...(data.list || []))
        onProgress?.(out.length, total)
      }
    }))
    return out
  }

  // ─── 报表（绩效考核用） ─────────────────────────────────

  /** 大报表：按成员分组、按会话接待时间（assign）统计，和「这段时间接待的会话」口径一致 */
  async fetchBigReport(startDate: string, endDate: string): Promise<SsReportRow[]> {
    const data = await this.get<{ list: SsReportRow[] }>('/api/v2/get-big-report', {
      start_date: startDate, end_date: endDate, group_by: 'sys_user_id', time_dimension: 'assign'
    })
    return data.list || []
  }

  /** 在线时长报表（按客服，单位秒；只做参考不计分） */
  async fetchOnlineDurationReport(startDate: string, endDate: string): Promise<SsOnlineRow[]> {
    const data = await this.get<{ list: SsOnlineRow[] }>('/api/v2/get-online-duration-report', { start_date: startDate, end_date: endDate })
    return data.list || []
  }

  // ─── 会话标签（AI 评级写回用） ───────────────────────────

  /** 按名称模糊搜最终会话标签（level=3） */
  async getSessionTags(tagName?: string): Promise<Array<{ id: number; tag_name: string; category_id: number }>> {
    const params: Record<string, string | number> = { page: 1, page_size: 200 }
    if (tagName) params.tag_name = tagName
    return (await this.get<{ list: Array<{ id: number; tag_name: string; category_id: number }> }>('/api/v2/get-session-tag-list', params)).list || []
  }

  /** 标签分类：parentId=0 查一级，传一级分类 ID 查它下面的二级 */
  async getTagCategories(parentId: number, name?: string): Promise<Array<{ id: number; category_name: string }>> {
    const params: Record<string, string | number> = { page: 1, page_size: 200, parent_category_id: parentId }
    if (name) params.category_name = name
    return (await this.get<{ list: Array<{ id: number; category_name: string }> }>('/api/v2/get-session-tag-category-list', params)).list || []
  }

  async addTagCategory(name: string, parentId = 0): Promise<number> {
    return (await this.post<{ res: number }>('/api/v2/add-session-tag-category', { category_name: name, parent_category_id: parentId })).res
  }

  async addSessionTag(name: string, categoryId: number): Promise<number> {
    return (await this.post<{ res: number }>('/api/v2/add-session-tag', { tag_name: name, category_id: categoryId })).res
  }

  /** 给会话打 / 删标签（append 追加 / replace 替换 / delete 删除指定的） */
  async tagSession(sessionId: string, tagIds: number[], updateType: 'append' | 'replace' | 'delete'): Promise<void> {
    await this.post('/api/v2/tag-session', { session_id: sessionId, tag_ids: tagIds.join(','), update_type: updateType })
  }

  /** 一个会话的全部聊天记录（自动翻页，最早的在前） */
  async fetchMessagesBySession(sessionId: string): Promise<SsMessage[]> {
    const out: SsMessage[] = []
    for (let page = 1; ; page++) {
      const data = await this.get<{ list: SsMessage[]; total: number }>('/api/v2/get-all-message-list', {
        page, page_size: 100, session_id: sessionId, sort_type: 1
      })
      const list = data.list || []
      out.push(...list)
      if (out.length >= (data.total ?? 0) || list.length === 0) break
    }
    return out
  }
}

/** 用某个部门已保存的设置建客户端 */
export async function salesmartly(deptCode: string): Promise<SalesmartlyClient> {
  return new SalesmartlyClient(await getDeptSetting(deptCode, 'salesmartly'))
}

/** 测试连接：拉一页团队成员，成功就报成员总数 */
export async function testSalesmartly(cfg: SalesmartlySettings): Promise<{ ok: boolean; message: string }> {
  try {
    const data = await new SalesmartlyClient(cfg).get<{ total: number }>('/api/v2/get-member-list', { page: 1, page_size: 1 })
    return { ok: true, message: `连接成功，项目共 ${data.total} 名团队成员` }
  } catch (err) {
    return { ok: false, message: describeFetchError(err) }
  }
}

/** fetch 的网络错误信息很笼统，翻译一下 */
export function describeFetchError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string } }
  if (e.name === 'TimeoutError') return '连接超时，请稍后再试'
  if (e.message === 'fetch failed') return `连不上服务器（${e.cause?.code || '网络错误'}），请检查地址和网络`
  return e.message || String(err)
}
