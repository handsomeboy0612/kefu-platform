/**
 * 部门设置读写。存在 settings 表（键值，值为 JSON），键名 dept:<部门code>:<项>，读的时候按默认值补齐字段。
 *
 * 每个部门各管各的（主管改自己部门，总管理员可以改任意部门），和原来桌面版各用各的一样：
 *   salesmartly  SaleSmartly 项目 ID、API Token、是否写回标签
 *   ai           AI 接口地址、API Key、模型
 *   archive      企业微信群聊归档服务地址、API Key（只有开了对公群的部门有）
 */
import { execute, now, query } from './db'
import { listDepartments, type Department } from './auth'

export interface SalesmartlySettings {
  projectId: string
  apiToken: string
  /** AI 评分结果写回 SaleSmartly 会话标签。桌面版还在写的时候先别开，免得两边重复写 */
  writeBackTags: boolean
}

export interface AISettings {
  apiBase: string
  apiKey: string
  model: string
}

export interface ArchiveSettings {
  serverUrl: string
  apiKey: string
}

export interface DeptSettings {
  salesmartly: SalesmartlySettings
  ai: AISettings
  archive: ArchiveSettings
}

export type DeptSection = keyof DeptSettings

export const DEPT_DEFAULTS: DeptSettings = {
  salesmartly: { projectId: '', apiToken: '', writeBackTags: false },
  ai: { apiBase: 'https://yunwu.ai/v1', apiKey: '', model: 'gpt-5.2' },
  // 归档服务和平台装在同一台机器上
  archive: { serverUrl: 'http://127.0.0.1:8091', apiKey: '' }
}

/** 各节里属于密钥的字段：接口返回时打码，保存时留空表示不修改 */
export const SECRET_FIELDS: Record<DeptSection, string[]> = {
  salesmartly: ['apiToken'],
  ai: ['apiKey'],
  archive: ['apiKey']
}

export const isDeptSection = (s: unknown): s is DeptSection =>
  typeof s === 'string' && Object.prototype.hasOwnProperty.call(DEPT_DEFAULTS, s)

export interface SettingMeta {
  updatedAt: number
  updatedBy: string
}

async function readRaw(key: string): Promise<{ value: unknown; meta: SettingMeta } | null> {
  const rows = await query<{ value: unknown; updated_at: number; updated_by: string }>(
    'SELECT value, updated_at, updated_by FROM settings WHERE `key` = ?',
    [key]
  )
  if (!rows[0]) return null
  let value = rows[0].value
  // mysql2 一般会把 JSON 列解析好；个别驱动配置下是字符串，兜底解析一次
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { value = null }
  }
  return { value, meta: { updatedAt: Number(rows[0].updated_at), updatedBy: rows[0].updated_by } }
}

const keyOf = (deptCode: string, section: DeptSection): string => `dept:${deptCode}:${section}`

/** 这个部门有哪些设置项：群聊归档只有开了对公群的部门才有 */
export function sectionsFor(dept: Department): DeptSection[] {
  return dept.groupChat ? ['salesmartly', 'ai', 'archive'] : ['salesmartly', 'ai']
}

/** 读部门的一项设置，缺的字段用默认值补上 */
export async function getDeptSetting<K extends DeptSection>(deptCode: string, section: K): Promise<DeptSettings[K]> {
  return (await getDeptSettingWithMeta(deptCode, section)).value
}

export async function getDeptSettingWithMeta<K extends DeptSection>(
  deptCode: string,
  section: K
): Promise<{ value: DeptSettings[K]; meta: SettingMeta | null }> {
  const raw = await readRaw(keyOf(deptCode, section))
  const stored = raw?.value && typeof raw.value === 'object' ? (raw.value as Partial<DeptSettings[K]>) : {}
  return { value: { ...DEPT_DEFAULTS[section], ...stored }, meta: raw?.meta ?? null }
}

export async function saveDeptSetting<K extends DeptSection>(
  deptCode: string,
  section: K,
  value: DeptSettings[K],
  updatedBy: string
): Promise<void> {
  await writeRaw(keyOf(deptCode, section), value, now(), updatedBy)
}

async function writeRaw(key: string, value: unknown, updatedAt: number, updatedBy: string): Promise<void> {
  await execute(
    `INSERT INTO settings (\`key\`, value, updated_at, updated_by) VALUES (?, CAST(? AS JSON), ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), updatedAt, updatedBy]
  )
}

/**
 * 早期版本这三项是全平台共用的（键名就是 salesmartly / ai / archive）。
 * 启动时复制给每个部门（群聊归档只给开了对公群的部门），部门里已经有的不覆盖，然后删掉旧键。可重复执行。
 */
export async function migrateLegacySettings(): Promise<void> {
  const depts = await listDepartments()
  for (const section of Object.keys(DEPT_DEFAULTS) as DeptSection[]) {
    const legacy = await readRaw(section)
    if (!legacy) continue
    for (const d of depts) {
      if (!sectionsFor(d).includes(section)) continue
      if (await readRaw(keyOf(d.code, section))) continue
      await writeRaw(keyOf(d.code, section), legacy.value, legacy.meta.updatedAt, legacy.meta.updatedBy)
    }
    await execute('DELETE FROM settings WHERE `key` = ?', [section])
    console.log(`[settings] 旧的共用设置「${section}」已复制到各部门`)
  }
}

/**
 * 把前端提交的字段合并到已保存的值上：
 * - 只认默认值里有的字段，类型按默认值转换（字符串去首尾空格、布尔转布尔）
 * - 密钥字段提交空字符串或不提交 = 不修改
 */
export function mergeSettingInput<K extends DeptSection>(
  section: K,
  saved: DeptSettings[K],
  input: Record<string, unknown>
): DeptSettings[K] {
  const out: Record<string, unknown> = { ...saved }
  const defaults = DEPT_DEFAULTS[section] as unknown as Record<string, unknown>
  for (const [field, def] of Object.entries(defaults)) {
    if (!(field in input)) continue
    const v = input[field]
    if (typeof def === 'boolean') {
      out[field] = Boolean(v)
    } else {
      const s = String(v ?? '').trim()
      if (SECRET_FIELDS[section].includes(field) && !s) continue
      out[field] = s
    }
  }
  // 地址统一去掉末尾斜杠
  if ('serverUrl' in out) out.serverUrl = String(out.serverUrl).replace(/\/+$/, '')
  if ('apiBase' in out) out.apiBase = String(out.apiBase).replace(/\/+$/, '')
  return out as unknown as DeptSettings[K]
}

/** 密钥打码：只告诉前端「有没有设置」和末 4 位，方便核对是不是同一个 */
export function maskSetting<K extends DeptSection>(section: K, value: DeptSettings[K]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) }
  for (const field of SECRET_FIELDS[section]) {
    const s = String(out[field] || '')
    delete out[field]
    out[`${field}Set`] = s.length > 0
    out[`${field}Tail`] = s.length >= 8 ? s.slice(-4) : ''
  }
  return out
}

/** 这一项必填的是否都填了（同步任务开跑前也用它检查） */
export function isSectionConfigured(section: DeptSection, v: DeptSettings[DeptSection]): boolean {
  switch (section) {
    case 'salesmartly': {
      const s = v as SalesmartlySettings
      return !!(s.projectId && s.apiToken)
    }
    case 'ai': {
      const s = v as AISettings
      return !!(s.apiBase && s.apiKey && s.model)
    }
    case 'archive': {
      const s = v as ArchiveSettings
      return !!(s.serverUrl && s.apiKey)
    }
  }
}
