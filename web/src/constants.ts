/** SaleSmartly 渠道 ID → 名称（和原桌面版一致） */
export const CHANNEL_NAMES: Record<number, string> = {
  1: 'FB私信', 2: '网页聊天', 3: '邮件', 4: 'Telegram', 5: 'Ins私信',
  6: 'LINE', 7: 'WhatsApp', 8: 'FB评论', 9: '第三方', 10: 'Slack',
  11: '微信客服', 12: 'WA个人号', 13: 'Ins评论', 14: '企业微信', 15: 'TG应用',
  16: 'TikTok私信', 17: 'TikTok评论', 18: 'VK', 19: 'Zalo', 20: 'TT商业号',
  21: 'TT商业评论', 22: 'YouTube', 23: '微信', 24: 'LINE个号',
  // 平台自己的来源：企业微信对公群（群消息切段后的群会话）
  [-2]: '企微群'
}

export const channelName = (c: number): string => CHANNEL_NAMES[c] || `渠道${c}`

/** 星级颜色：4~5 主色，3 琥珀，1~2 砖红（和参考页的好评 / 差评配色一致） */
export const starColor = (v: number): string => (v >= 4 ? 'var(--app-blue)' : v === 3 ? 'var(--app-orange)' : 'var(--app-terracotta)')

/** 秒 → 「3分钟」「1h20m」 */
export function fmtDuration(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60))
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}分钟`
}

export const GRADES = ['优秀', '良好', '合格', '待改进', '不合格'] as const

/** 评级配色：浅底深字，和整体米白 / 藏青风格一致 */
export const GRADE_STYLE: Record<string, { bg: string; color: string }> = {
  优秀: { bg: '#E8F3EC', color: '#2F6B47' },
  良好: { bg: '#ECEDF8', color: '#0C1754' },
  合格: { bg: '#FBF1DF', color: '#8A5A0B' },
  待改进: { bg: '#F8E9E5', color: '#9C3B26' },
  不合格: { bg: '#EFEDEA', color: '#57545B' }
}

/** AI 分数颜色 */
export const scoreColor = (v: number): string => (v >= 90 ? '#2F6B47' : v >= 75 ? 'var(--app-blue)' : v >= 60 ? '#8A5A0B' : '#9C3B26')
