/**
 * 部门的 AI 质检配置：提示词、评分维度和权重、是否每晚自动评分。
 * 存在 settings 表，键名 dept:<部门code>:quality；没存过就用默认值（按部门的考核模板选）。
 */
import { execute, now, query } from '../db'
import type { Department } from '../auth'
import { CS_DIMENSIONS, CS_PROMPT, TECH_DIMENSIONS, TECH_PROMPT, type Dimension } from './defaults'

export type { Dimension }

export interface QualityConfig {
  prompt: string
  dimensions: Dimension[]
  /** 每晚 01:00 自动评前一天没评过的会话（参与考核的客服、客户发过言的） */
  autoNightly: boolean
}

export function defaultQuality(dept: Department): QualityConfig {
  return dept.kpiTemplate === 'tech'
    ? { prompt: TECH_PROMPT, dimensions: TECH_DIMENSIONS, autoNightly: false }
    : { prompt: CS_PROMPT, dimensions: CS_DIMENSIONS, autoNightly: false }
}

const keyOf = (dept: Department): string => `dept:${dept.code}:quality`

export async function getQuality(dept: Department): Promise<{ value: QualityConfig; isDefault: boolean; updatedAt: number; updatedBy: string }> {
  const [row] = await query<{ value: unknown; updated_at: number; updated_by: string }>(
    'SELECT value, updated_at, updated_by FROM settings WHERE `key` = ?', [keyOf(dept)]
  )
  const def = defaultQuality(dept)
  if (!row) return { value: def, isDefault: true, updatedAt: 0, updatedBy: '' }
  let v = row.value as Partial<QualityConfig> | string
  if (typeof v === 'string') {
    try { v = JSON.parse(v) as Partial<QualityConfig> } catch { v = {} }
  }
  const stored = v as Partial<QualityConfig>
  return {
    value: {
      prompt: stored.prompt || def.prompt,
      dimensions: Array.isArray(stored.dimensions) && stored.dimensions.length ? stored.dimensions : def.dimensions,
      autoNightly: !!stored.autoNightly
    },
    isDefault: false,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by
  }
}

/** 校验并整理维度：名称不能空、不能重复，权重是正整数，合计 100 */
export function normalizeDimensions(input: unknown): Dimension[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('至少要有一个评分维度')
  if (input.length > 10) throw new Error('评分维度最多 10 个')
  const out: Dimension[] = []
  for (const d of input as Array<{ name?: unknown; weight?: unknown }>) {
    const name = String(d?.name ?? '').trim()
    const weight = Number(d?.weight)
    if (!name) throw new Error('维度名称不能为空')
    if (name.length > 20) throw new Error(`维度名称太长：${name}`)
    if (out.some((x) => x.name === name)) throw new Error(`维度名称重复：${name}`)
    if (!Number.isInteger(weight) || weight <= 0 || weight > 100) throw new Error(`「${name}」的权重要填 1~100 的整数`)
    out.push({ name, weight })
  }
  const sum = out.reduce((s, d) => s + d.weight, 0)
  if (sum !== 100) throw new Error(`各维度权重加起来要等于 100（现在是 ${sum}）`)
  return out
}

export async function saveQuality(dept: Department, value: QualityConfig, by: string): Promise<void> {
  await execute(
    `INSERT INTO settings (\`key\`, value, updated_at, updated_by) VALUES (?, CAST(? AS JSON), ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
    [keyOf(dept), JSON.stringify(value), now(), by]
  )
}

/** 分数 → 评级（和桌面版提示词里写的一致：90 / 75 / 60 / 40） */
export function gradeOf(total: number): string {
  if (total >= 90) return '优秀'
  if (total >= 75) return '良好'
  if (total >= 60) return '合格'
  if (total >= 40) return '待改进'
  return '不合格'
}
