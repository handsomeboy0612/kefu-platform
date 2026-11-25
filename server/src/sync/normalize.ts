/**
 * SaleSmartly 原始消息 → 平台消息（客户 / 客服 / 机器人 / 系统）。从桌面版 sync-service 原样搬过来。
 *
 * 实测字段语义（和文档有出入，以真实数据为准）：
 * - sender_type：1-用户 2-团队成员 3-系统。is_system 实测恒为 -1，不能用来判断机器人
 * - 机器人：content.channel_info.auto_info.auto_type 有值（如 "flow"）就是聊天流程 / 自动回复
 * - content：整条消息的 JSON，msg 字段是正文（字符串）或事件 / 媒体对象：
 *   - msg 是字符串：正文（模板消息时是再套一层 JSON 的字符串，正文在 payload.text）
 *   - msg.type = create_session / end_session / update_user…：会话生命周期事件
 *   - msg.file_url：媒体消息的资源地址
 */
import type { SsMessage } from '../services/salesmartly'

export type SenderType = 'customer' | 'staff' | 'bot' | 'system'

export interface MessageRow {
  mid: string
  senderType: SenderType
  senderName: string
  content: string
  msgType: number
  sendTime: number
  imageUrl: string
  recalled: number
}

/** 时间归一成秒：兼容毫秒 / 微秒（sequence_id 是微秒级） */
export function toSec(t: number): number {
  let v = t
  while (v > 1e12) v = Math.floor(v / 1000)
  return v
}

const isHttpUrl = (text: string): boolean => /^https?:\/\/\S+$/i.test((text || '').trim())
const isImageUrl = (url: string): boolean => /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(url)

/** msg_type → 占位文字（官方消息类型表）。没有正文又不在表里的按原样 */
const MSG_TYPE_PLACEHOLDER: Record<number, string> = {
  2: '[图片]', 3: '[模板消息]', 4: '[文件]', 5: '[回传]', 6: '[视频]',
  7: '[邮件]', 10: '[邮件提醒]', 12: '[语音]', 13: '[FB评论]', 14: '[商品卡片]',
  19: '[信息调查]', 22: '[贴纸]', 23: '[位置]', 24: '[消息列表]', 26: '[互动消息]',
  27: '[Ins评论]', 28: '[通话记录]', 29: '[联系人名片]', 31: '[商品目录]', 32: '[订单]',
  34: '[超大文件]', 35: '[无法解密的消息]', 38: '[WhatsApp消息]', 39: '[TikTok评论]',
  40: '[图文消息]', 43: '[TikTok商业评论]', 44: '[直播消息]',
  45: '[搜图消息]', 46: '[商品消息]'
}

/** 媒体地址 → 正文：图片单独存地址，其他类型拼在占位后面 */
function mediaContent(msgType: number, url: string): { content: string; imageUrl: string } {
  if (msgType === 2 || isImageUrl(url)) return { content: '[图片]', imageUrl: url }
  if (msgType === 6) return { content: `[视频] ${url}`, imageUrl: '' }
  if (msgType === 12) return { content: `[语音] ${url}`, imageUrl: '' }
  return { content: `[文件] ${url}`, imageUrl: '' }
}

/** 返回 null 表示对质检没意义的内部事件，丢掉 */
export function normalizeMessage(m: SsMessage, staffNames: Map<string, string>, fallbackStaffName: string): MessageRow | null {
  let senderType: SenderType
  let senderName: string
  if (m.sender_type === 2) {
    senderType = 'staff'
    senderName = staffNames.get(String(m.sender)) || fallbackStaffName || '客服'
  } else if (m.sender_type === 3 || m.is_system === 1) {
    senderType = 'system'
    senderName = '系统'
  } else {
    senderType = 'customer'
    senderName = '客户'
  }
  const asSystem = (): void => { senderType = 'system'; senderName = '系统' }

  let payload: unknown
  if (m.content) {
    try {
      const parsed = JSON.parse(m.content) as { msg?: unknown; channel_info?: unknown }
      payload = parsed?.msg
      // channel_info 普通消息是 []，机器人消息是带 auto_info 的对象
      const ci = parsed?.channel_info as { auto_info?: { auto_type?: string } } | unknown[] | undefined
      if (ci && !Array.isArray(ci) && ci.auto_info?.auto_type) {
        senderType = 'bot'
        senderName = '机器人'
      }
    } catch { /* 不是 JSON，用 text 兜底 */ }
  }

  const text = (m.text || '').trim()
  let content = text
  let imageUrl = ''

  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    const eventType = typeof p.type === 'string' ? p.type : ''
    if (eventType === 'create_session') {
      asSystem(); content = '[会话开始]'
    } else if (eventType === 'end_session') {
      asSystem(); content = '[会话结束]'
    } else if (/transfer|assign/i.test(eventType)) {
      asSystem(); content = '[会话转接]'
    } else if (typeof p.file_url === 'string' && p.file_url) {
      ({ content, imageUrl } = mediaContent(m.msg_type, p.file_url))
    } else if (eventType || m.msg_type === 8) {
      return null // update_user 等内部事件
    }
  } else if (typeof payload === 'string' && payload.trim()) {
    const inner = payload.trim()
    if (isHttpUrl(inner) && [2, 4, 6, 12].includes(m.msg_type)) {
      // 部分渠道（如网页聊天插件）媒体消息的 msg 直接就是 URL 字符串
      ({ content, imageUrl } = mediaContent(m.msg_type, inner))
    } else if (inner.startsWith('{')) {
      // 模板消息：msg 是再套一层 JSON 的字符串（邀评卡片、机器人欢迎语等）
      try {
        const tpl = JSON.parse(inner) as { type?: string; payload?: { text?: string } }
        if (tpl?.type === 'invite_evalution') {
          asSystem(); content = '[已发送满意度邀评]'
        } else if (typeof tpl?.payload?.text === 'string' && tpl.payload.text.trim()) {
          content = tpl.payload.text.trim()
        } else {
          content = text || '[模板消息]'
        }
      } catch {
        content = text || '[模板消息]'
      }
    } else if (!content) {
      content = inner
    }
  }

  // 没有负载信息时按 msg_type 最后兜底
  if (!imageUrl) {
    switch (m.msg_type) {
      case 2:
        if (isHttpUrl(content)) { imageUrl = content; content = '[图片]' } else if (!content) content = '[图片]'
        break
      case 4: content = isHttpUrl(content) ? `[文件] ${content}` : content || '[文件]'; break
      case 6: content = isHttpUrl(content) ? `[视频] ${content}` : content || '[视频]'; break
      case 12: content = isHttpUrl(content) ? `[语音] ${content}` : content || '[语音]'; break
      default:
        if (!content || content.startsWith('{')) content = MSG_TYPE_PLACEHOLDER[m.msg_type] || content
    }
  }
  if (!content) return null

  return {
    mid: (m.mid || String(m.sequence_id || '')).slice(0, 64),
    senderType,
    senderName,
    content,
    msgType: m.msg_type,
    sendTime: toSec(m.send_time),
    imageUrl: imageUrl.slice(0, 1024),
    recalled: m.is_withdraw ? 1 : 0
  }
}
