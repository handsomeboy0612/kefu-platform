/**
 * 对公群设置（只有开了对公群的部门有）：哪些群算、群聊停多久开始 AI 整理（gapMin）。存在 settings 表 dept:<code>:groupChat。
 */
import { execute, now, query } from '../db'
import type { Department } from '../auth'

export interface GroupConfig {
  /** keyword = 群名含关键词的群（空 = 全部），自动去掉全是员工的内部群；manual = 只算手动勾选的群 */
  roomFilterMode: 'keyword' | 'manual'
  roomKeyword: string
  selectedRooms: string[]
  /** 同一个群相邻两条消息隔多久算另一段（分钟） */
  gapMin: number
}

export const GROUP_DEFAULTS: GroupConfig = { roomFilterMode: 'keyword', roomKeyword: '', selectedRooms: [], gapMin: 30 }

const keyOf = (dept: Department): string => `dept:${dept.code}:groupChat`

export async function getGroupConfig(dept: Department): Promise<GroupConfig> {
  const [row] = await query<{ value: unknown }>('SELECT value FROM settings WHERE `key` = ?', [keyOf(dept)])
  let v = row?.value
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { v = {} } }
  const r = (v && typeof v === 'object' ? v : {}) as Partial<GroupConfig>
  return {
    roomFilterMode: r.roomFilterMode === 'manual' ? 'manual' : 'keyword',
    roomKeyword: typeof r.roomKeyword === 'string' ? r.roomKeyword : '',
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
