/**
 * 对公群设置（只有开了对公群的部门有）：哪些群算、群聊停多久开始 AI 整理（gapMin）。存在 settings 表 dept:<code>:groupChat。
 */
import { execute, now, query } from '../db'
import type { Department } from '../auth'

export interface GroupConfig {
  /** keyword = 群名含关键词的群（空 = 全部），自动去掉全是员工的内部群；manual = 只算手动勾选的群 */
  roomFilterMode: 'keyword' | 'manual'
  roomKeyword: string
  /** 按关键词选群时，群名含这些字的不算（如渠道合作群「云雾API渠道」，以后给渠道部单独做；消息照样由归档服务采集） */
  excludeKeywords: string[]
  selectedRooms: string[]
  /** 群聊停多久（分钟）开始 AI 整理 */
  gapMin: number
}

export const GROUP_DEFAULTS: GroupConfig = { roomFilterMode: 'keyword', roomKeyword: '', excludeKeywords: ['云雾API渠道'], selectedRooms: [], gapMin: 30 }

/** 排除关键词：数组或「逗号 / 空格分开」的文字都行；去重、去空，最多 20 个 */
export function parseKeywords(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,，、\s]+/) : []
  return [...new Set(list.map((x) => x.trim().slice(0, 30)).filter(Boolean))].slice(0, 20)
}

/** 这个群算不算对公群（不含「全是员工的内部群」判断，那个要拉群成员，同步时单独判断） */
export function roomCounted(c: GroupConfig, roomId: string, roomName: string): boolean {
  if (c.roomFilterMode === 'manual') return c.selectedRooms.includes(roomId)
  // 不分大小写（有的群写成「云雾api渠道」）
  const name = (roomName || '').toLowerCase()
  if (c.roomKeyword && !name.includes(c.roomKeyword.toLowerCase())) return false
  return !c.excludeKeywords.some((k) => name.includes(k.toLowerCase()))
}

const keyOf = (dept: Department): string => `dept:${dept.code}:groupChat`

export async function getGroupConfig(dept: Department): Promise<GroupConfig> {
  const [row] = await query<{ value: unknown }>('SELECT value FROM settings WHERE `key` = ?', [keyOf(dept)])
  let v = row?.value
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { v = {} } }
  const r = (v && typeof v === 'object' ? v : {}) as Partial<GroupConfig>
  return {
    roomFilterMode: r.roomFilterMode === 'manual' ? 'manual' : 'keyword',
    roomKeyword: typeof r.roomKeyword === 'string' ? r.roomKeyword : '',
    excludeKeywords: r.excludeKeywords === undefined ? GROUP_DEFAULTS.excludeKeywords : parseKeywords(r.excludeKeywords),
    selectedRooms: Array.isArray(r.selectedRooms) ? r.selectedRooms.map(String) : [],
    gapMin: Number(r.gapMin) >= 5 && Number(r.gapMin) <= 240 ? Math.round(Number(r.gapMin)) : 30
  }
}

export async function saveGroupConfig(dept: Department, c: GroupConfig, by: string): Promise<void> {
  await execute(
    `INSERT INTO settings (\`key\`, value, updated_at, updated_by) VALUES (?, CAST(? AS JSON), ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
    [keyOf(dept), JSON.stringify(c), now(), by]
  )
}
