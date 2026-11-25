/**
 * AI 质检：给一个会话打分。上下文注记（会话结束状态、响应时间分析、转接场景、发言统计）从桌面版原样搬过来；
 * 输出格式改成按部门配置的维度生成，总分按权重算、评级按总分算（不用 AI 自己给的）。
 */
import { createHash } from 'crypto'
import type { AISettings } from '../settings'
import { describeAIError } from '../services/ai'
import { describeFetchError } from '../services/salesmartly'
import { gradeOf, type QualityConfig } from './config'

export interface ScoreMessage {
  senderType: 'customer' | 'staff' | 'bot' | 'system'
  senderName: string
  content: string
  sendTime: number
  imageUrl: string
  recalled: boolean
}

export interface ScoreInput {
  messages: ScoreMessage[]
  /** 人工接待开始时间（assign_time，没有就用会话开始时间） */
  serviceBeginTime: number
  endTime: number
  /** 满意度星级，0 = 未评价 */
  starScore: number
}

export interface ScoreResult {
  total: number
  grade: string
  dimensions: Array<{ name: string; weight: number; score: number }>
  highlights: string[]
  issues: string[]
  summary: string
  improvement: string
  raw: unknown
  model: string
  promptHash: string
  tokensIn: number
  tokensOut: number
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'low' } }

const pad = (n: number): string => String(n).padStart(2, '0')
const fmtTime = (sec: number): string => {
  const d = new Date(sec * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const isDialog = (m: ScoreMessage): boolean => m.senderType !== 'system'
const isStaff = (m: ScoreMessage): boolean => m.senderType === 'staff'
const isCustomer = (m: ScoreMessage): boolean => m.senderType === 'customer'

const roleLabel = (m: ScoreMessage): string => {
  switch (m.senderType) {
    case 'staff': return `【客服-${m.senderName}】`
    case 'bot': return '【机器人】'
    case 'system': return '【系统】'
    default: return '【客户】'
  }
}

/** 客户表示认可 / 确认的简短回复 */
const AFFIRMATION_RE = /^(好的?|嗯+|收到|谢谢|感谢|ok|okay|好哒|行|知道了|明白了?|没问题|可以|1|👍|thx|thanks|号的?|好好|明白)$/i

function buildConversationContent(messages: ScoreMessage[]): { parts: ContentPart[]; statsNote: string } {
  const parts: ContentPart[] = []
  const lines: string[] = []
  const counter = { staff: 0, customer: 0, bot: 0, recalled: 0 }
  const flush = (): void => {
    if (lines.length) {
      parts.push({ type: 'text', text: lines.join('\n') })
      lines.length = 0
    }
  }

  for (const msg of messages) {
    const label = roleLabel(msg)
    const bump = (): void => {
      if (msg.senderType === 'system') return
      if (msg.recalled) counter.recalled++
      else counter[msg.senderType]++
    }
    if (msg.imageUrl && !msg.recalled) {
      // 图片地址是公开的，直接给视觉模型看
      lines.push(`${fmtTime(msg.sendTime)} ${label}: [发送了一张图片]`)
      flush()
      parts.push({ type: 'image_url', image_url: { url: msg.imageUrl, detail: 'low' } })
      bump()
    } else if (msg.content) {
      lines.push(`${fmtTime(msg.sendTime)} ${label}: ${msg.recalled ? `[已撤回] ${msg.content}` : msg.content}`)
      bump()
    }
  }
  flush()

  const statsNote = `## 📊 对话发言统计（系统自动统计，AI 必须以此为准）
- 【客服】共发言 ${counter.staff} 条（不含已撤回）
- 【客户】共发言 ${counter.customer} 条（不含已撤回）
- 【机器人】共发言 ${counter.bot} 条（不计入人工服务评分）
${counter.recalled > 0
    ? `- 另有 ${counter.recalled} 条消息被撤回，已用 \`[已撤回]\` 标注：这些内容客户实际未收到，**不计入有效发言、不据其内容评分**；偶尔撤回纠正属正常操作，不得仅因存在撤回而扣分。`
    : ''}
${counter.staff > 0
    ? `✅ 本会话中人工客服有 ${counter.staff} 条有效发言，AI 评分必须承认客服存在有效回复。`
    : '⚠️ 本会话人工客服无有效发言记录，请以此为准评分。'}`

  return { parts, statsNote }
}

/**
 * 最后一条「人说的」消息：跳过末尾机器人的自动提醒（「还有其他问题吗」「长时间没回复将关闭会话」）。
 * 实测 2026-11 九成会话最后是这类提醒，桌面版按字面取最后一条，导致大部分会话拿不到结束状态说明。
 */
function lastHumanMessage(messages: ScoreMessage[]): { last: ScoreMessage | undefined; trailingBot: boolean } {
  const valid = messages.filter((m) => isDialog(m) && !m.recalled)
  const humans = valid.filter((m) => m.senderType !== 'bot')
  const last = humans[humans.length - 1]
  return { last, trailingBot: !!last && valid[valid.length - 1] !== last }
}

/** 会话结束状态：明确告诉 AI 最后一条是谁发的，以及对各维度的影响（最高优先级） */
function buildSessionEndNote(messages: ScoreMessage[]): string {
  const { last, trailingBot } = lastHumanMessage(messages)
  if (!last) return ''
  const lastTime = fmtTime(last.sendTime)
  const botNote = trailingBot ? '\n（之后只有机器人的自动提醒，如「还有其他问题吗」「长时间未回复将关闭会话」，不算对话，不影响评分）' : ''

  if (isStaff(last)) {
    return `## ⚠️ 会话结束状态（高优先级，必须以此为准）
最后一条消息：【客服】于 ${lastTime} 发出，之后客户未再发言，会话自然结束。${botNote}

**以下结论由系统分析确认，AI 评分必须遵守：**
- ✅ 客户收到客服回复后未继续提问 = 问题已得到处理，会话正常结束
- ✅ 响应速度：不存在任何滞后（最后一条是客服消息）
- ✅ 服务完整度：客服已给出答复，客户无后续追问，视为服务完整
- ✅ 主动服务：客服主动作出了回应，无需额外追加跟进
- ❌ 严禁以"客户没有回复确认"为由扣服务完整度或主动服务意识分
- ❌ 严禁推断"客服未跟进""服务中断""问题未解决"等结论`
  }
  if (isCustomer(last)) {
    const txt = (last.content || '').trim()
    if (AFFIRMATION_RE.test(txt)) {
      return `## ⚠️ 会话结束状态（高优先级，必须以此为准）
最后一条消息：【客户】于 ${lastTime} 回复"${txt}"，确认词明确表达认可。${botNote}

**以下结论由系统分析确认，AI 评分必须遵守：**
- ✅ 客户主动确认满意，问题已解决，服务成功
- ✅ 响应速度、服务完整度、主动服务均不得因此扣分
- ❌ 严禁以"客服未继续跟进"为由扣主动服务意识分（客户已确认，无需再跟进）`
    }
    return `## ⚠️ 会话结束状态（高优先级，必须以此为准）
最后一条消息：【客户】于 ${lastTime} 发出，客服未作回复。${botNote}

**以下结论由系统分析确认，AI 评分必须遵守：**
- ⚠️ 客服未回复客户最后一条消息，需根据消息内容判断是否属于服务缺失
- 若客户最后消息是告别语或无需回复的确认词，无需扣分
- 若客户最后消息是新问题或明确需要回复的内容，酌情扣服务完整度`
  }
  return ''
}

/** 响应时间分析：只列「客户发言后客服超过 2 分钟才回」的片段，排除客服说完后客户没回的间隔 */
function buildResponseTimeNote(messages: ScoreMessage[]): string {
  const valid = messages.filter((m) => isDialog(m) && !m.recalled)
  const SHORT_OK = /^(好的?|嗯+|收到|谢谢|感谢|ok|okay|好哒|行|知道了|明白了?|没问题|可以|1|👍|thx|thanks)$/i

  // 最后一个确认词之后客户没再实质提问，就认为问题已解决，之后的间隔不算
  let resolvedIdx = -1
  for (let i = valid.length - 1; i >= 0; i--) {
    if (!isCustomer(valid[i])) continue
    if (SHORT_OK.test((valid[i].content || '').trim())) {
      const followUp = valid.slice(i + 1).filter(isCustomer).some((m) => !SHORT_OK.test((m.content || '').trim()))
      if (!followUp) { resolvedIdx = i; break }
    }
  }

  const slow: string[] = []
  for (let i = 0; i < valid.length - 1; i++) {
    const cur = valid[i]
    const next = valid[i + 1]
    if (!isCustomer(cur) || isCustomer(next)) continue
    if (resolvedIdx >= 0 && i >= resolvedIdx) continue
    const gapMin = Math.round((next.sendTime - cur.sendTime) / 60)
    if (gapMin >= 2) slow.push(`- ${fmtTime(cur.sendTime)} 客户发言 → ${fmtTime(next.sendTime)} 客服回复，间隔 ${gapMin} 分钟（需评估是否滞后）`)
  }

  const { last } = lastHumanMessage(messages)
  let lastNote = ''
  if (last) {
    const t = fmtTime(last.sendTime)
    if (isStaff(last)) lastNote = `\n⚠️ 会话最后一条消息由【客服】于 ${t} 发出，之后客户未回复，此间隔不计入响应速度。`
    else if (isCustomer(last) && resolvedIdx < 0) lastNote = `\n⚠️ 会话最后一条消息由【客户】于 ${t} 发出，客服未跟进，需评估。`
  }
  if (resolvedIdx >= 0) {
    lastNote += `\n✅ 客户于 ${fmtTime(valid[resolvedIdx].sendTime)} 回复确认词（"${(valid[resolvedIdx].content || '').trim()}"），问题视为已解决，此后间隔不计入响应速度，客服结束会话属正常操作。`
  }
  if (!slow.length && !lastNote) return '\n## 响应时间分析\n✅ 客服回复及时，无明显滞后。'
  const body = slow.length
    ? `\n以下为客户发言后客服回复间隔超过2分钟的片段（仅供参考）：\n${slow.join('\n')}`
    : '\n✅ 客户发言后客服均及时回复，无超时片段。'
  return `\n## 响应时间分析（已由系统预计算，请以此为准）${body}${lastNote}`
}

/** 机器人 → 人工转接：转接前后客户说「继续 / 刚才 / 转人工」只是标准话术，不代表有未承接的历史问题 */
function buildTransferNote(messages: ScoreMessage[]): string {
  const hasBot = messages.some((m) => m.senderType === 'bot')
  const firstStaff = messages.findIndex(isStaff)
  if (!hasBot || firstStaff < 0) return ''
  const TRANSFER_RE = /继续|接着|接上|刚才|已经发起过|已咨询|已经咨询|接手|接着上次|刚刚问过|之前问的|转人工|人工/
  const trigger = messages
    .slice(Math.max(0, firstStaff - 3), Math.min(messages.length, firstStaff + 4))
    .find((m) => isCustomer(m) && TRANSFER_RE.test(m.content || ''))
  if (!trigger) return ''
  return `## 📋 转接场景识别（系统自动标注，AI 必须以此为准）
本会话经历了【机器人 → 人工客服】的转接流程。
客户在转人工前后说："${(trigger.content || '').slice(0, 60)}"

**这是在线客服的标准转接话术，含义是"请人工客服来接待我"，并不代表：**
- ❌ 存在尚未解决的"历史问题"需要查档承接
- ❌ 客服必须翻阅机器人对话历史
- ❌ 客服未承接客户诉求

**正确评分标准：**
- ✅ 人工客服接手后正常问候、并针对客户话题提供信息 = 服务已承接，完整度合格
- ✅ 客服无需主动询问"你之前问的是什么"，按当前对话内容回答即可
- ✅ 不得以"未承接历史问题"或"未跟进历史咨询"为由扣服务完整度或主动服务分`
}

/** 输出要求：按部门的维度生成。提示词里另外要求的字段（问题清单、扣分明细等）照常输出，平台原样保存 */
function buildFooter(q: QualityConfig): string {
  const dims = q.dimensions.map((d) => `    "${d.name}": 0到100的数字`).join(',\n')
  const weights = q.dimensions.map((d) => `${d.name} ${d.weight}%`).join('、')
  return `
## 输出要求（平台统一格式，必须遵守）
只输出一个 JSON 对象，不要输出任何其他内容。下面这些字段必须有：
{
  "各维度得分": {
${dims}
  },
  "亮点": ["具体优点，没有就给空数组"],
  "问题": ["具体问题，尽量引用会话原文或时间点，没有就给空数组"],
  "评语": "总体评价，不超过 50 字",
  "改进建议": "针对性的改进建议，不超过 80 字，没有就写“无”"
}
系统提示里还要求了其他字段（如问题清单、回应统计、扣分明细）的，一并放进这个 JSON。
各维度权重：${weights}。总分和评级由系统按权重计算（90 以上优秀、75 以上良好、60 以上合格、40 以上待改进、其余不合格），不需要你算。`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 可以重试的错误（限流、网关 5xx、网络、超时） */
export class RetryableError extends Error {}

/** 配置问题（Key 无效、没权限、模型不存在）：重试和继续评别的都没用，批量评分遇到就停 */
export class AIConfigError extends Error {}

export async function callAI(ai: AISettings, body: unknown): Promise<{ content: string; model: string; tokensIn: number; tokensOut: number }> {
  let res: Response
  try {
    res = await fetch(`${ai.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000)
    })
  } catch (err) {
    throw new RetryableError(`连不上 AI 接口：${describeFetchError(err)}`)
  }
  const text = await res.text()
  if (!res.ok) {
    const msg = describeAIError(res.status, text, ai.model)
    if (res.status === 429 || res.status >= 500) throw new RetryableError(msg)
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new AIConfigError(msg)
    throw new Error(msg)
  }
  let data: { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  try {
    data = JSON.parse(text)
  } catch {
    throw new RetryableError(`AI 接口返回的不是 JSON：${text.slice(0, 80)}`)
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new RetryableError('AI 返回内容为空')
  return {
    content,
    model: data.model || ai.model,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0
  }
}

/** 从 AI 输出里取一个字符串数组；兼容提示词自定义的「加分明细 / 扣分明细」这种对象数组 */
function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => {
      if (typeof x === 'string') return x.trim()
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>
        const head = [o['维度'], o['分值'] !== undefined ? String(o['分值']) : ''].filter(Boolean).join(' ')
        const reason = String(o['原因'] ?? o['说明'] ?? o['内容'] ?? '')
        return [head, reason].filter(Boolean).join('：').trim() || JSON.stringify(x)
      }
      return ''
    })
    .filter(Boolean)
    .slice(0, 20)
}

function parseResult(content: string, q: QualityConfig): Omit<ScoreResult, 'model' | 'promptHash' | 'tokensIn' | 'tokensOut'> {
  // 个别模型会套一层 ```json
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(cleaned)
  } catch {
    throw new RetryableError(`AI 返回的 JSON 解析失败：${content.slice(0, 120)}`)
  }
  const dimObj = (obj['各维度得分'] ?? obj['dimensions']) as Record<string, unknown> | undefined
  if (!dimObj || typeof dimObj !== 'object') throw new RetryableError('AI 返回里没有「各维度得分」')

  const dimensions = q.dimensions.map((d) => {
    const v = Number(dimObj[d.name])
    if (!Number.isFinite(v)) throw new RetryableError(`AI 返回里缺少维度「${d.name}」的分数`)
    return { name: d.name, weight: d.weight, score: Math.round(Math.min(100, Math.max(0, v)) * 10) / 10 }
  })
  const total = Math.round(dimensions.reduce((s, d) => s + d.score * d.weight, 0) / 100 * 10) / 10

  const highlights = toStringList(obj['亮点'] ?? obj['highlights'] ?? obj['加分明细'])
  const issues = toStringList(obj['问题'] ?? obj['issues'] ?? obj['扣分明细'])
  const str = (...keys: string[]): string => {
    for (const k of keys) if (typeof obj[k] === 'string' && (obj[k] as string).trim()) return (obj[k] as string).trim()
    return ''
  }
  return {
    total,
    grade: gradeOf(total),
    dimensions,
    highlights,
    issues,
    summary: str('评语', 'summary', '总体评价').slice(0, 500),
    improvement: str('改进建议', 'improvement').slice(0, 1000),
    raw: obj
  }
}

export const promptHash = (q: QualityConfig): string =>
  createHash('sha256').update(JSON.stringify([q.prompt, q.dimensions])).digest('hex').slice(0, 12)

/** 给一个会话打分。限流 / 网络 / 格式不对会自动重试两次 */
export async function scoreConversation(input: ScoreInput, q: QualityConfig, ai: AISettings): Promise<ScoreResult> {
  if (!ai.apiKey) throw new AIConfigError('本部门还没有填 AI 接口的 API Key，请到「设置 → 数据源与 AI」填写')
  const { parts, statsNote } = buildConversationContent(input.messages)
  if (!parts.some((p) => p.type === 'image_url' || p.text.trim())) throw new Error('会话没有聊天内容，不能评分')

  const duration = input.endTime > 0 && input.serviceBeginTime > 0 ? input.endTime - input.serviceBeginTime : 0
  const header = [
    buildSessionEndNote(input.messages),
    buildTransferNote(input.messages),
    statsNote,
    `## 会话基本信息
- 人工服务时长：${duration > 0 ? `${Math.round(duration / 60)} 分钟` : '未知'}
- 客户满意度评价：${input.starScore > 0 ? `${input.starScore} 星（5 星制）` : '未评价'}
${buildResponseTimeNote(input.messages)}

## 会话记录（文字+图片）`
  ].filter(Boolean).join('\n\n') + '\n'

  const body = {
    model: ai.model,
    messages: [
      { role: 'system', content: q.prompt },
      { role: 'user', content: [{ type: 'text', text: header }, ...parts, { type: 'text', text: buildFooter(q) }] }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await callAI(ai, body)
      return { ...parseResult(r.content, q), model: r.model, promptHash: promptHash(q), tokensIn: r.tokensIn, tokensOut: r.tokensOut }
    } catch (err) {
      lastErr = err
      if (!(err instanceof RetryableError)) throw err
      await sleep(3000 * (attempt + 1))
    }
  }
  throw lastErr instanceof Error ? new Error(lastErr.message) : new Error(String(lastErr))
}
