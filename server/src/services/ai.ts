/**
 * AI 接口（OpenAI 兼容格式）。这一步只有测试连接；质检评分在后面搬过来。
 */
import type { AISettings } from '../settings'
import { describeFetchError } from './salesmartly'

/**
 * 测试连接：用配置的模型、按真实评分相同的参数（temperature + JSON 输出）发一次很短的请求。
 * 只查 /models 的话模型名写错也会显示「连接正常」，要到评分时才报错。
 */
export async function testAI(cfg: AISettings): Promise<{ ok: boolean; message: string }> {
  if (!cfg.apiKey) return { ok: false, message: '还没有填写 API Key' }
  if (!cfg.model) return { ok: false, message: '还没有填写模型名称' }
  let res: Response
  try {
    res = await fetch(`${cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: '你是连通性测试助手，只输出 JSON。' },
          { role: 'user', content: '请只输出这个 JSON：{"ok": true}' }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(60_000)
    })
  } catch (err) {
    return { ok: false, message: `连不上 AI 接口：${describeFetchError(err)}（检查接口地址）` }
  }

  const text = await res.text()
  if (!res.ok) return { ok: false, message: describeAIError(res.status, text, cfg.model) }

  let data: { model?: string; choices?: Array<{ message?: { content?: string } }> }
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, message: `接口返回的不是 JSON，接口地址可能填错了（应以 /v1 结尾）：${text.slice(0, 80)}` }
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) return { ok: false, message: `模型 ${cfg.model} 返回内容为空，评分时会失败` }
  try {
    JSON.parse(content)
  } catch {
    return { ok: false, message: `模型 ${cfg.model} 没有按 JSON 格式返回，评分时会解析失败：${content.slice(0, 80)}` }
  }
  const actual = data.model ? `（实际响应模型：${data.model}）` : ''
  return { ok: true, message: `连接正常，模型 ${cfg.model} 可用${actual}` }
}

/** 把 AI 接口报错翻译成看得懂的原因（兼容 OpenAI 格式和各类中转网关） */
export function describeAIError(status: number, bodyText: string, model: string): string {
  let detail = bodyText
  try {
    const d = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string }
    detail = (typeof d.error === 'string' ? d.error : d.error?.message) || d.message || bodyText
  } catch { /* 不是 JSON 就用原文 */ }
  detail = String(detail).slice(0, 200)
  const low = detail.toLowerCase()
  const tail = detail ? `：${detail}` : ''

  if (status === 401 || status === 403) {
    if (/model|模型|channel|渠道|分组|group/.test(low)) return `当前 API Key 无权使用模型 ${model}${tail}`
    return `API Key 无效或没有权限（HTTP ${status}）${tail}`
  }
  if (status === 404 || /model.*(not|无|不存在|exist|support)|no such model|模型.*(不存在|不支持|未开通)|no available channel|无可用渠道/.test(low)) {
    return `模型 ${model} 不存在或当前账号不可用，请核对模型名称${tail}`
  }
  if (/response_format|json_object|json mode/.test(low)) return `模型 ${model} 不支持 JSON 输出格式，评分会失败${tail}`
  if (/temperature/.test(low)) return `模型 ${model} 不支持评分使用的 temperature 参数${tail}`
  if (status === 429) return `请求过于频繁或额度不足（HTTP 429）${tail}`
  return `AI 接口返回 HTTP ${status}${tail}`
}
