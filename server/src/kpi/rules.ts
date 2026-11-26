/**
 * 两套考核规则（从桌面版原样搬过来）：
 * - cs：客服部（桌面版 main 分支）—— 接待量 / 回复率 / 满意度 / 响应速度 / AI 质量五项，通宵班专用公式
 * - tech：技术支持部（桌面版 feat/sessions-total-count，2026-11-11 标准）——
 *   总 KPI = 第一项·客服接待 × 45% + 第二项·对公群技术售后 × 45% + 主管评分（0~10）
 * 规则存在 settings 表 dept:<code>:kpiRules，读的时候按默认值逐节补齐（和桌面版一样）。
 */
import { execute, now, query } from '../db'
import type { Department } from '../auth'

// ─── 通用 ──────────────────────────────────────────────

export interface GradeRule { label: string; min: number; coeff: number }
export interface ResponseTier { maxSec: number; percent: number }

// ─── 客服部 ────────────────────────────────────────────

export interface ReplyRateTiers { fullRate: number; midRate: number; midPercent: number }
export interface NightResponseTier { maxSec: number; score: number }

export interface CsRules {
  /** 五项分数占比，合计 = 100；某项设为 0 即不考核 */
  weights: { sessions: number; replyRate: number; satisfaction: number; response: number; aiQuality: number }
  /** 接待量溢出奖励：日均 ≥ 团队日均 × bonusRatio 时额外 +bonusExtra */
  sessions: { bonusRatio: number; bonusExtra: number }
  replyRate: ReplyRateTiers
  /** 回复率秒退宽限（秒）：没回复且存活时间小于这个的会话不进分母 */
  replyGraceSec: number
  /** 满意度：均分 ≥ fullStar 满分；参评 < minReviews 条按宽限给满分；passStar 只用于展示 */
  satisfaction: { fullStar: number; minReviews: number; passStar?: number }
  /** 响应速度 = 首次响应（tiers / firstScore）+ 平均响应（avgTiers / avgScore） */
  response: { tiers: ResponseTier[]; firstScore: number; avgScore: number; avgTiers: ResponseTier[] }
  /** AI 质检中位数 ≥ fullThreshold 得满分，否则按比例 */
  aiQuality: { fullThreshold: number }
  /** 通宵班：回复率低于次档 0 分；响应阶梯直接给分（接待量并入响应，不单独计分） */
  night: { replyRate: ReplyRateTiers; responseTiers: NightResponseTier[]; avgResponseTiers: NightResponseTier[] }
  grades: GradeRule[]
}

export const CS_DEFAULT_RULES: CsRules = {
  weights: { sessions: 20, replyRate: 5, satisfaction: 35, response: 15, aiQuality: 25 },
  sessions: { bonusRatio: 1.2, bonusExtra: 5 },
  replyRate: { fullRate: 99, midRate: 98, midPercent: 80 },
  replyGraceSec: 180,
  satisfaction: { fullStar: 4.9, minReviews: 5, passStar: 4.5 },
  response: {
    tiers: [{ maxSec: 60, percent: 100 }, { maxSec: 120, percent: 80 }, { maxSec: 180, percent: 66.7 }],
    firstScore: 15,
    avgScore: 0,
    avgTiers: [{ maxSec: 60, percent: 100 }, { maxSec: 120, percent: 80 }, { maxSec: 180, percent: 66.7 }]
  },
  aiQuality: { fullThreshold: 95 },
  night: {
    replyRate: { fullRate: 100, midRate: 98, midPercent: 60 },
    responseTiers: [{ maxSec: 60, score: 35 }, { maxSec: 120, score: 25 }, { maxSec: 180, score: 14 }],
    avgResponseTiers: []
  },
  grades: [
    { label: 'S', min: 100, coeff: 1.2 },
    { label: 'A', min: 90, coeff: 1.0 },
    { label: 'B', min: 75, coeff: 0.9 },
    { label: 'C', min: 0, coeff: 0.8 }
  ]
}

// ─── 技术支持部 ────────────────────────────────────────

export interface SessionBonusTier { ratio: number; extra: number }
/** 量化曲线：达平均得 avgPercent%，满分线 = 平均 × fullRatio；floorAtAvg = 低于平均也按平均算 */
export interface VolumeCurve { avgPercent: number; fullRatio: number; floorAtAvg: boolean; bonusTiers: SessionBonusTier[] }
/** 三点曲线：≥ full 满分，= mid 得 midPercent%，≤ zero 得 0，之间线性 */
export interface RateCurve { full: number; mid: number; midPercent: number; zero: number }

export interface TechRules {
  /** 过渡期：AI 质量无数据时分值加给接待量 / 满意度 / 响应；评价不足 minReviews 条用团队均分 */
  transition: boolean
  total: { part1Weight: number; part2Weight: number; supervisorMax: number; supervisorDefault: number }
  part1: {
    weights: { sessions: number; firstResp: number; avgResp: number; satisfaction: number; aiQuality: number; replyRate: number }
    sessions: { dayEvening: VolumeCurve; night: VolumeCurve }
    firstRespTiers: ResponseTier[]
    avgRespTiers: ResponseTier[]
    satisfaction: { curve: RateCurve; priorCount: number; passStar: number; minReviews: number }
    aiQuality: { full: number; zero: number }
    replyRate: { curve: RateCurve; graceSec: number }
    deduction: { complaint: number; unresolvedBad: number; violation: number; cap: number }
  }
  part2: {
    /** ai = 按 AI 整理的群问题（一个问题算一个，有处理时效、闭环率）；rule = 按规则切的群会话（处理时效、闭环率不计分） */
    source: 'ai' | 'rule'
    weights: { solved: number; firstResp: number; avgResp: number; timeliness: number; closure: number; satisfaction: number }
    solved: { dayEvening: VolumeCurve; night: VolumeCurve }
    firstRespTiers: ResponseTier[]
    avgRespTiers: ResponseTier[]
    /** 难度加权：简单 ×1，一般 ×normal，疑难 ×hard（难度由主管在「群问题」里标，没标的按简单） */
    difficulty: { normal: number; hard: number }
    /**
     * 处理时效：从首次响应到给出解决方案。fullSec 内处理完得满分；超过了但处理人每 syncSec 内至少同步一次进度
     * （只回「稍等」「还在看」不算），得 syncedPercent%；中间没同步得 0。每个已解决的问题单独打分再平均
     */
    timeliness: { fullSec: number; syncSec: number; syncedPercent: number }
    /**
     * 问题闭环率 = 各问题计分之和 ÷ 问题数（判断不了的确认前不算）：自己解决 1，没解决但交接完整 handedFull，
     * 交接不完整 handedPart，没交接 0。points：闭环率达到 rate% 得该项分值的 percent%，点之间线性，低于最后一点按最后一点
     */
    closureRule: { handedFull: number; handedPart: number; points: Array<{ rate: number; percent: number }> }
    satisfaction: { complaint: number; mild: number; praise: number; praiseCap: number }
    deduction: { ignored1h: number; ignored2h: number; handoverMiss: number; wrongInfo: number; violation: number; cap: number }
  }
  grades: GradeRule[]
  star: { partMin: number; totalMin: number }
}

export const TECH_DEFAULT_RULES: TechRules = {
  transition: true,
  total: { part1Weight: 45, part2Weight: 45, supervisorMax: 10, supervisorDefault: 7 },
  part1: {
    weights: { sessions: 35, firstResp: 10, avgResp: 15, satisfaction: 20, aiQuality: 15, replyRate: 5 },
    sessions: {
      dayEvening: { avgPercent: 80, fullRatio: 1.3, floorAtAvg: false, bonusTiers: [{ ratio: 1.5, extra: 3 }, { ratio: 2, extra: 5 }] },
      night: { avgPercent: 80, fullRatio: 1.15, floorAtAvg: true, bonusTiers: [{ ratio: 1.3, extra: 3 }, { ratio: 1.7, extra: 5 }] }
    },
    firstRespTiers: [
      { maxSec: 30, percent: 100 }, { maxSec: 60, percent: 90 }, { maxSec: 90, percent: 80 },
      { maxSec: 120, percent: 65 }, { maxSec: 180, percent: 50 }
    ],
    avgRespTiers: [
      { maxSec: 60, percent: 100 }, { maxSec: 90, percent: 90 }, { maxSec: 120, percent: 80 },
      { maxSec: 180, percent: 60 }, { maxSec: 240, percent: 40 }
    ],
    satisfaction: { curve: { full: 4.8, mid: 4.0, midPercent: 60, zero: 3.0 }, priorCount: 3, passStar: 4.5, minReviews: 3 },
    aiQuality: { full: 95, zero: 60 },
    replyRate: { curve: { full: 99, mid: 98, midPercent: 80, zero: 90 }, graceSec: 180 },
    deduction: { complaint: 5, unresolvedBad: 2, violation: 10, cap: 15 }
  },
  part2: {
    source: 'ai',
    weights: { solved: 35, firstResp: 10, avgResp: 15, timeliness: 10, closure: 20, satisfaction: 10 },
    solved: {
      dayEvening: { avgPercent: 80, fullRatio: 1.3, floorAtAvg: false, bonusTiers: [{ ratio: 1.5, extra: 3 }, { ratio: 2, extra: 5 }] },
      night: { avgPercent: 80, fullRatio: 1.15, floorAtAvg: true, bonusTiers: [{ ratio: 1.3, extra: 3 }, { ratio: 1.7, extra: 5 }] }
    },
    firstRespTiers: [
      { maxSec: 60, percent: 100 }, { maxSec: 120, percent: 85 }, { maxSec: 180, percent: 70 },
      { maxSec: 300, percent: 50 }, { maxSec: 600, percent: 25 }
    ],
    avgRespTiers: [
      { maxSec: 90, percent: 100 }, { maxSec: 150, percent: 85 }, { maxSec: 210, percent: 70 },
      { maxSec: 300, percent: 50 }, { maxSec: 480, percent: 25 }
    ],
    difficulty: { normal: 1.5, hard: 2 },
    timeliness: { fullSec: 3600, syncSec: 3600, syncedPercent: 70 },
    closureRule: {
      handedFull: 0.8, handedPart: 0.4,
      points: [{ rate: 95, percent: 100 }, { rate: 90, percent: 80 }, { rate: 80, percent: 50 }, { rate: 70, percent: 0 }]
    },
    satisfaction: { complaint: 5, mild: 2, praise: 1, praiseCap: 3 },
    deduction: { ignored1h: 3, ignored2h: 5, handoverMiss: 3, wrongInfo: 10, violation: 10, cap: 15 }
  },
  grades: [
    { label: 'S', min: 95, coeff: 1.2 },
    { label: 'A', min: 85, coeff: 1.0 },
    { label: 'B', min: 70, coeff: 0.9 },
    { label: 'C', min: 0, coeff: 0.8 }
  ],
  star: { partMin: 80, totalMin: 90 }
}

/** 技术支持部每月人工录入（按 sys_user_id）：主管评分 + 两大项的投诉 / 扣分 */
export interface ManualEntry {
  supervisorScore?: number
  supervisorNote?: string
  p1Complaints?: number
  p1UnresolvedBad?: number
  p1Violation?: boolean
  p2Complaints?: number
  p2MildComplaints?: number
  p2Praise?: number
  p2Ignored1h?: number
  p2Ignored2h?: number
  p2HandoverMiss?: number
  p2WrongInfo?: number
  p2Violation?: boolean
}

// ─── 读写 ──────────────────────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const arr = <T>(v: unknown, d: T[]): T[] => (Array.isArray(v) && v.length ? (v as T[]) : d)

function mergeCs(raw: Obj): CsRules {
  const D = CS_DEFAULT_RULES
  const r = raw as Partial<CsRules>
  const weights = { ...D.weights, ...(r.weights || {}) }
  return {
    weights,
    sessions: { ...D.sessions, ...(r.sessions || {}) },
    replyRate: { ...D.replyRate, ...(r.replyRate || {}) },
    replyGraceSec: r.replyGraceSec ?? D.replyGraceSec,
    satisfaction: { ...D.satisfaction, ...(r.satisfaction || {}) },
    response: {
      tiers: arr(r.response?.tiers, D.response.tiers),
      firstScore: r.response?.firstScore ?? D.response.firstScore,
      avgScore: r.response?.avgScore ?? D.response.avgScore,
      avgTiers: arr(r.response?.avgTiers, D.response.avgTiers)
    },
    aiQuality: { ...D.aiQuality, ...(r.aiQuality || {}) },
    night: {
      replyRate: { ...D.night.replyRate, ...(r.night?.replyRate || {}) },
      responseTiers: arr(r.night?.responseTiers, D.night.responseTiers),
      avgResponseTiers: Array.isArray(r.night?.avgResponseTiers) ? r.night!.avgResponseTiers : D.night.avgResponseTiers
    },
    grades: arr(r.grades, D.grades)
  }
}

function mergeTech(raw: Obj): TechRules {
  const D = TECH_DEFAULT_RULES
  const r = raw as Partial<TechRules>
  if (!isObj(r.part1) || !isObj(r.part2)) return D
  const curve = (v: Partial<VolumeCurve> | undefined, d: VolumeCurve): VolumeCurve => ({ ...d, ...(v || {}), bonusTiers: v?.bonusTiers ?? d.bonusTiers })
  const p1 = r.part1
  const p2 = r.part2
  return {
    transition: r.transition ?? D.transition,
    total: { ...D.total, ...(r.total || {}) },
    part1: {
      weights: { ...D.part1.weights, ...(p1.weights || {}) },
      sessions: { dayEvening: curve(p1.sessions?.dayEvening, D.part1.sessions.dayEvening), night: curve(p1.sessions?.night, D.part1.sessions.night) },
      firstRespTiers: arr(p1.firstRespTiers, D.part1.firstRespTiers),
      avgRespTiers: arr(p1.avgRespTiers, D.part1.avgRespTiers),
      satisfaction: { ...D.part1.satisfaction, ...(p1.satisfaction || {}), curve: { ...D.part1.satisfaction.curve, ...(p1.satisfaction?.curve || {}) } },
      aiQuality: { ...D.part1.aiQuality, ...(p1.aiQuality || {}) },
      replyRate: { ...D.part1.replyRate, ...(p1.replyRate || {}), curve: { ...D.part1.replyRate.curve, ...(p1.replyRate?.curve || {}) } },
      deduction: { ...D.part1.deduction, ...(p1.deduction || {}) }
    },
    part2: {
      source: p2.source === 'rule' || p2.source === 'ai' ? p2.source : D.part2.source,
      weights: { ...D.part2.weights, ...(p2.weights || {}) },
      solved: { dayEvening: curve(p2.solved?.dayEvening, D.part2.solved.dayEvening), night: curve(p2.solved?.night, D.part2.solved.night) },
      firstRespTiers: arr(p2.firstRespTiers, D.part2.firstRespTiers),
      avgRespTiers: arr(p2.avgRespTiers, D.part2.avgRespTiers),
      difficulty: { ...D.part2.difficulty, ...(p2.difficulty || {}) },
      timeliness: { ...D.part2.timeliness, ...(p2.timeliness || {}) },
      closureRule: { ...D.part2.closureRule, ...(p2.closureRule || {}), points: arr(p2.closureRule?.points, D.part2.closureRule.points) },
      satisfaction: { ...D.part2.satisfaction, ...(p2.satisfaction || {}) },
      deduction: { ...D.part2.deduction, ...(p2.deduction || {}) }
    },
    grades: arr(r.grades, D.grades),
    star: { ...D.star, ...(r.star || {}) }
  }
}

const keyOf = (dept: Department): string => `dept:${dept.code}:kpiRules`

export type AnyRules = CsRules | TechRules

export const defaultRules = (dept: Department): AnyRules => (dept.kpiTemplate === 'tech' ? TECH_DEFAULT_RULES : CS_DEFAULT_RULES)

export async function getRules(dept: Department): Promise<{ rules: AnyRules; isDefault: boolean; updatedAt: number; updatedBy: string }> {
  const [row] = await query<{ value: unknown; updated_at: number; updated_by: string }>(
    'SELECT value, updated_at, updated_by FROM settings WHERE `key` = ?', [keyOf(dept)]
  )
  if (!row) return { rules: defaultRules(dept), isDefault: true, updatedAt: 0, updatedBy: '' }
  let v = row.value
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { v = {} } }
  const raw = isObj(v) ? v : {}
  return {
    rules: dept.kpiTemplate === 'tech' ? mergeTech(raw) : mergeCs(raw),
    isDefault: false,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by
  }
}

export async function saveRules(dept: Department, rules: AnyRules, by: string): Promise<void> {
  await execute(
    `INSERT INTO settings (\`key\`, value, updated_at, updated_by) VALUES (?, CAST(? AS JSON), ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
    [keyOf(dept), JSON.stringify(rules), now(), by]
  )
}

export async function resetRules(dept: Department): Promise<void> {
  await execute('DELETE FROM settings WHERE `key` = ?', [keyOf(dept)])
}

/** 保存前的合并 + 校验：按部门模板合并（补齐缺的字段），再检查权重合计 */
export function normalizeRules(dept: Department, input: unknown): AnyRules {
  if (!isObj(input)) throw new Error('规则格式不对')
  if (dept.kpiTemplate === 'tech') {
    const r = mergeTech(input)
    if (r === TECH_DEFAULT_RULES && (!isObj(input.part1) || !isObj(input.part2))) throw new Error('规则格式不对：缺少第一项 / 第二项')
    const t = r.total
    if (t.part1Weight + t.part2Weight + t.supervisorMax !== 100) throw new Error(`第一项 + 第二项 + 主管评分要等于 100（现在是 ${t.part1Weight + t.part2Weight + t.supervisorMax}）`)
    const s1 = Object.values(r.part1.weights).reduce((a, b) => a + b, 0)
    const s2 = Object.values(r.part2.weights).reduce((a, b) => a + b, 0)
    if (Math.abs(s1 - 100) > 0.01) throw new Error(`第一项各小项分值合计要等于 100（现在是 ${s1}）`)
    if (Math.abs(s2 - 100) > 0.01) throw new Error(`第二项各小项分值合计要等于 100（现在是 ${s2}）`)
    return r
  }
  const r = mergeCs(input)
  const s = Object.values(r.weights).reduce((a, b) => a + b, 0)
  if (Math.abs(s - 100) > 0.01) throw new Error(`五项分数占比合计要等于 100（现在是 ${s}）`)
  if (Math.abs(r.response.firstScore + r.response.avgScore - r.weights.response) > 0.01) {
    throw new Error(`响应速度：首次响应分值 + 平均响应分值要等于响应速度占比 ${r.weights.response}`)
  }
  return r
}
