/**
 * 技术支持部绩效计算（桌面版 feat/sessions-total-count 的 kpi-service 原样搬过来，去掉了企微存档并入）。
 * 总 KPI = 第一项·客服接待 × part1Weight% + 第二项·对公群技术售后 × part2Weight% + 主管评分。
 * 某一小项没数据就不计分，大项得分 = 实际得分 ÷ 能考核小项的满分合计 × 100；加分扣分在折算后统一加减。
 *
 * 第二项（对公群）：按《技术支持部绩效考核标准》第三部分，按 AI 整理的群问题算（处理人、状态、难度按主管改过的）。
 * 没有对公群问题的人第二项不考核，总 KPI 按第一项折算。
 */
import type { GradeRule, ManualEntry, RateCurve, ResponseTier, TechRules, VolumeCurve } from './rules'
import type { KpiInputs } from './inputs'
import type { SsReportRow } from '../services/salesmartly'

const r1 = (n: number): number => Math.round(n * 10) / 10

/** 小项：score = null 表示没数据、不计分（折算时连满分一起去掉） */
export interface KpiItem { score: number | null; full: number }

export interface TechPart1 {
  score: number
  base: number
  bonus: number
  deduction: number
  grade: string
  coeff: number
  transitionApplied: boolean
  items: { sessions: KpiItem; firstResp: KpiItem; avgResp: KpiItem; satisfaction: KpiItem; aiQuality: KpiItem; replyRate: KpiItem }
  sessionCnt: number
  teamAvgCnt: number
  avgResponseSec: number
  avgReplySec: number
  respNoData: boolean
  avgStar: number
  usedStar: number | null
  teamStar: number | null
  scoredCnt: number
  invitedCnt: number
  badReviewDeducted: number
  replyRate: number
  replyNum: number
  replyDen: number
  replyGraced: number
  replyLocal: boolean
  aiAvgScore: number | null
  aiScoredCount: number
}

export interface TechPart2 {
  score: number
  base: number
  bonus: number
  praise: number
  deduction: number
  grade: string
  coeff: number
  items: { solved: KpiItem; firstResp: KpiItem; avgResp: KpiItem; timeliness: KpiItem; closure: KpiItem; satisfaction: KpiItem }
  /** 'ai' = 按群问题算（2026-11-26 以前生成的报表可能没有这个字段，是按时间切段算的） */
  source: 'ai'
  threadCnt: number
  roomCnt: number
  teamAvgCnt: number
  avgFirstSec: number | null
  avgReplySec: number | null
  /** 难度加权后的问题数（解决问题数按这个和团队平均比） */
  weightedCnt: number
  resolvedCnt: number
  unresolvedCnt: number
  /** 没解决但交接了（完整 / 不完整） */
  handedCnt: number
  unknownCnt: number
  closureRate: number | null
  avgResolveSec: number | null
}

export interface TechKpiResult {
  sysUserId: number
  name: string
  shiftLabel: string
  isNight: boolean
  p1: TechPart1 | null
  p2: TechPart2 | null
  supervisorScore: number
  supervisorNote: string
  supervisorDefaulted: boolean
  finalScore: number
  star: boolean
  loginSec: number
  onlineSec: number
  busySec: number
}

/**
 * 对公群里的一个群问题（或规则群会话）：首响 / 均响（秒）。群问题另有：状态（resolved / unresolved / handed / handed_part / unknown）、
 * 处理时长（首次响应 → 解决）、期间最长多久没同步进度、难度（1 简单 / 2 一般 / 3 疑难）
 */
export interface GroupThread { firstSec: number | null; avgSec: number | null; status?: string; resolveSec?: number | null; syncGapSec?: number | null; difficulty?: number }
/** 对公群每人的群问题（或规则群会话） */
export type GroupStats = Record<string, { name: string; roomCnt: number; threads: GroupThread[] }>

function volumePct(cnt: number, avg: number, c: VolumeCurve): { pct: number; bonus: number } {
  if (avg <= 0) return { pct: 100, bonus: 0 }
  let pct: number
  if (cnt >= avg * c.fullRatio) pct = 100
  else if (cnt >= avg) pct = c.avgPercent + ((cnt - avg) / (avg * (c.fullRatio - 1))) * (100 - c.avgPercent)
  else pct = c.floorAtAvg ? c.avgPercent : (cnt / avg) * c.avgPercent
  const hit = [...c.bonusTiers].sort((a, b) => b.ratio - a.ratio).find((t) => cnt >= avg * t.ratio)
  return { pct: Math.min(100, pct), bonus: hit?.extra ?? 0 }
}

function tierPct(sec: number, tiers: ResponseTier[]): number {
  for (const t of [...tiers].sort((a, b) => a.maxSec - b.maxSec)) if (sec <= t.maxSec) return t.percent
  return 0
}

function curvePct(v: number, c: RateCurve): number {
  if (v >= c.full) return 100
  if (v >= c.mid) return c.full > c.mid ? c.midPercent + ((v - c.mid) / (c.full - c.mid)) * (100 - c.midPercent) : 100
  if (v > c.zero) return ((v - c.zero) / (c.mid - c.zero)) * c.midPercent
  return 0
}

/** 处理时效得分比例：只算已解决的问题 */
export function timelinessPct(P: TechRules['part2'], t: GroupThread): number | null {
  if (t.status !== 'resolved' || t.resolveSec == null) return null
  const T = P.timeliness
  if (t.resolveSec <= T.fullSec) return 100
  return t.syncGapSec != null && t.syncGapSec <= T.syncSec ? T.syncedPercent : 0
}

/** 一个问题的闭环计分（0 ~ 1）；判断不了的确认前不算（null） */
export function closureValue(P: TechRules['part2'], status: string | undefined): number | null {
  switch (status) {
    case 'resolved': return 1
    case 'handed': return P.closureRule.handedFull
    case 'handed_part': return P.closureRule.handedPart
    case 'unresolved': return 0
    default: return null
  }
}

/** 闭环率（%）→ 得分比例：按点线性折算 */
export function closurePct(rate: number, points: Array<{ rate: number; percent: number }>): number {
  const ps = [...points].sort((a, b) => b.rate - a.rate)
  if (!ps.length) return 0
  if (rate >= ps[0].rate) return ps[0].percent
  for (let i = 1; i < ps.length; i++) {
    const hi = ps[i - 1]
    const lo = ps[i]
    if (rate >= lo.rate) return hi.rate > lo.rate ? lo.percent + ((rate - lo.rate) / (hi.rate - lo.rate)) * (hi.percent - lo.percent) : hi.percent
  }
  return ps[ps.length - 1].percent
}

/** 难度权重：简单 1，一般 / 疑难按规则 */
export const difficultyWeight = (P: TechRules['part2'], d: number | undefined): number => (d === 3 ? P.difficulty.hard : d === 2 ? P.difficulty.normal : 1)

/**
 * 单个群问题的得分（会话记录里显示）：第二项里能按单个问题算的几项——首次响应、平均响应、处理时效、是否解决——
 * 按各自分值加权平均，0 ~ 100。判断不了的问题不算「是否解决」；没解决的不算处理时效。
 * 人的第二项还要看解决问题数、闭环率（按全部问题算）、满意度和扣分，不等于单题分的平均。
 */
export function issueScore(P: TechRules['part2'], t: GroupThread): { score: number | null; parts: Record<string, number | null> } {
  const w = P.weights
  const parts: Record<string, number | null> = {
    firstResp: t.firstSec == null ? null : tierPct(t.firstSec, P.firstRespTiers),
    avgResp: t.avgSec == null ? null : tierPct(t.avgSec, P.avgRespTiers),
    timeliness: timelinessPct(P, t),
    closure: ((v) => (v === null ? null : v * 100))(closureValue(P, t.status))
  }
  let num = 0
  let den = 0
  for (const [k, v] of Object.entries(parts)) {
    const wk = w[k as keyof typeof w] || 0
    if (v === null || wk <= 0) continue
    num += v * wk
    den += wk
  }
  return { score: den > 0 ? r1(num / den) : null, parts }
}

function scale(items: KpiItem[]): number {
  const counted = items.filter((i) => i.score !== null && i.full > 0)
  const full = counted.reduce((s, i) => s + i.full, 0)
  if (full <= 0) return 0
  return (counted.reduce((s, i) => s + (i.score as number), 0) / full) * 100
}

/** 等级：S 需当月无有效投诉；违规当月不能评 S / A */
function getGrade(score: number, grades: GradeRule[], complaints: number, violation: boolean): { grade: string; coeff: number } {
  const sorted = [...grades].sort((a, b) => b.min - a.min)
  const allowed = sorted.filter((g) => !(violation && (g.label === 'S' || g.label === 'A')) && !(complaints > 0 && g.label === 'S'))
  for (const g of allowed) if (score >= g.min) return { grade: g.label, coeff: g.coeff }
  const last = sorted[sorted.length - 1]
  return { grade: last?.label || 'C', coeff: last?.coeff ?? 0.8 }
}

/** 团队平均：只算白班、晚班；没有白 / 晚班成员时退回排除通宵班的全员 */
function teamAverage(entries: Array<[string, number]>): number {
  const de = entries.filter(([k]) => k === 'day' || k === 'evening')
  const base = de.length ? de : entries.filter(([k]) => k !== 'night')
  return base.length ? base.reduce((s, [, n]) => s + n, 0) / base.length : 0
}

const roundItem = (i: KpiItem): KpiItem => ({ full: r1(i.full), score: i.score === null ? null : r1(i.score) })

function calcPart1(
  r: SsReportRow, R: TechRules, m: ManualEntry, isNight: boolean,
  x: {
    teamAvg: number
    star: { sum: number; cnt: number; deduct: number }
    teamStar: number | null
    reply?: { den: number; num: number; graced: number }
    ai: { avg: number; count: number } | null
  }
): TechPart1 {
  const P = R.part1
  const w = { ...P.weights }
  const webCnt = r.start_session_pv || 0

  const aiAvg = x.ai ? r1(x.ai.avg) : null
  const transitionApplied = aiAvg === null && R.transition && w.aiQuality > 0
  if (transitionApplied) {
    // 过渡期：AI 的分值平均加给接待量 / 满意度 / 响应速度（响应按首响、均响比例拆）
    const share = w.aiQuality / 3
    const respSum = w.firstResp + w.avgResp
    w.sessions += share
    w.satisfaction += share
    if (respSum > 0) {
      w.firstResp += share * (w.firstResp / respSum)
      w.avgResp += share * (w.avgResp / respSum)
    }
    w.aiQuality = 0
  }
  const aiQuality: KpiItem = {
    full: w.aiQuality,
    score: aiAvg === null || w.aiQuality <= 0 ? null
      : (Math.min(100, Math.max(0, ((aiAvg - P.aiQuality.zero) / (P.aiQuality.full - P.aiQuality.zero)) * 100)) / 100) * w.aiQuality
  }

  const vol = volumePct(webCnt, x.teamAvg, isNight ? P.sessions.night : P.sessions.dayEvening)
  const sessions: KpiItem = { full: w.sessions, score: (vol.pct / 100) * w.sessions }

  const respNoData = (r.fst_reply_session_cnt || 0) === 0
  const firstSec = Math.round(r.avg_fst_replay_time || 0)
  const replySec = Math.round(r.avg_replay_time || 0)
  const firstResp: KpiItem = { full: w.firstResp, score: respNoData ? 0 : (tierPct(firstSec, P.firstRespTiers) / 100) * w.firstResp }
  const avgResp: KpiItem = { full: w.avgResp, score: respNoData ? 0 : (tierPct(replySec, P.avgRespTiers) / 100) * w.avgResp }

  const ownAvg = x.star.cnt > 0 ? x.star.sum / x.star.cnt : -1
  let usedStar: number | null = null
  if (x.teamStar !== null) {
    usedStar = R.transition
      ? (x.star.cnt < P.satisfaction.minReviews ? x.teamStar : ownAvg)
      : (x.star.sum + P.satisfaction.priorCount * x.teamStar) / (x.star.cnt + P.satisfaction.priorCount)
  }
  const satisfaction: KpiItem = {
    full: w.satisfaction,
    score: usedStar === null ? null : (curvePct(usedStar, P.satisfaction.curve) / 100) * w.satisfaction
  }

  const replyLocal = !!x.reply && x.reply.den > 0
  const replyNum = replyLocal ? x.reply!.num : (r.fst_reply_session_cnt || 0)
  const replyDen = replyLocal ? x.reply!.den : webCnt
  const replyRate = replyDen > 0 ? replyNum / replyDen : 0
  const replyItem: KpiItem = { full: w.replyRate, score: replyDen > 0 ? (curvePct(replyRate * 100, P.replyRate.curve) / 100) * w.replyRate : null }

  const items = { sessions, firstResp, avgResp, satisfaction, aiQuality, replyRate: replyItem }
  const base = scale(Object.values(items))
  const D = P.deduction
  const complaints = m.p1Complaints || 0
  const deduction = Math.min(D.cap, complaints * D.complaint + (m.p1UnresolvedBad || 0) * D.unresolvedBad + (m.p1Violation ? D.violation : 0))
  const score = r1(Math.max(0, base + vol.bonus - deduction))
  const g = getGrade(score, R.grades, complaints, !!m.p1Violation)

  return {
    score, base: r1(base), bonus: vol.bonus, deduction, grade: g.grade, coeff: g.coeff, transitionApplied,
    items: {
      sessions: roundItem(sessions), firstResp: roundItem(firstResp), avgResp: roundItem(avgResp),
      satisfaction: roundItem(satisfaction), aiQuality: roundItem(aiQuality), replyRate: roundItem(replyItem)
    },
    sessionCnt: webCnt,
    teamAvgCnt: r1(x.teamAvg),
    avgResponseSec: firstSec,
    avgReplySec: replySec,
    respNoData,
    avgStar: ownAvg < 0 ? -1 : Math.round(ownAvg * 100) / 100,
    usedStar: usedStar === null ? null : Math.round(usedStar * 100) / 100,
    teamStar: x.teamStar === null ? null : Math.round(x.teamStar * 100) / 100,
    scoredCnt: x.star.cnt,
    invitedCnt: r.is_invit_pv || 0,
    badReviewDeducted: x.star.deduct,
    replyRate, replyNum, replyDen,
    replyGraced: x.reply?.graced ?? 0,
    replyLocal,
    aiAvgScore: aiAvg,
    aiScoredCount: x.ai?.count ?? 0
  }
}

function calcPart2(R: TechRules, m: ManualEntry, isNight: boolean, wg: GroupStats[string], teamAvg: number): TechPart2 {
  const P = R.part2
  const w = P.weights
  const threadCnt = wg.threads.length
  const weightedCnt = wg.threads.reduce((s, t) => s + difficultyWeight(P, t.difficulty), 0)
  const vol = volumePct(weightedCnt, teamAvg, isNight ? P.solved.night : P.solved.dayEvening)
  const solved: KpiItem = { full: w.solved, score: (vol.pct / 100) * w.solved }

  const firsts = wg.threads.map((t) => t.firstSec).filter((s): s is number => s !== null)
  const avgs = wg.threads.map((t) => t.avgSec).filter((s): s is number => s !== null)
  const meanPct = (secs: number[], tiers: ResponseTier[]): number | null =>
    secs.length ? secs.reduce((s, sec) => s + tierPct(sec, tiers), 0) / secs.length : null
  const fp = meanPct(firsts, P.firstRespTiers)
  const ap = meanPct(avgs, P.avgRespTiers)
  const firstResp: KpiItem = { full: w.firstResp, score: fp === null ? null : (fp / 100) * w.firstResp }
  const avgResp: KpiItem = { full: w.avgResp, score: ap === null ? null : (ap / 100) * w.avgResp }
  const cnt = (s: string): number => wg.threads.filter((t) => t.status === s).length
  const resolvedCnt = cnt('resolved')
  const unresolvedCnt = cnt('unresolved')
  const handedCnt = cnt('handed') + cnt('handed_part')
  const unknownCnt = threadCnt - resolvedCnt - unresolvedCnt - handedCnt
  const tps = wg.threads.map((t) => timelinessPct(P, t)).filter((x): x is number => x !== null)
  const timeliness: KpiItem = { full: w.timeliness, score: tps.length ? (tps.reduce((a, b) => a + b, 0) / tps.length / 100) * w.timeliness : null }
  const cvs = wg.threads.map((t) => closureValue(P, t.status)).filter((x): x is number => x !== null)
  const closureRate = cvs.length ? (cvs.reduce((a, b) => a + b, 0) / cvs.length) * 100 : null
  const closure: KpiItem = { full: w.closure, score: closureRate === null ? null : (closurePct(closureRate, P.closureRule.points) / 100) * w.closure }
  const resolveSecs = wg.threads.filter((t) => t.status === 'resolved').map((t) => t.resolveSec).filter((s): s is number => s != null)

  const S = P.satisfaction
  const complaints = m.p2Complaints || 0
  const satisfaction: KpiItem = { full: w.satisfaction, score: Math.max(0, w.satisfaction - complaints * S.complaint - (m.p2MildComplaints || 0) * S.mild) }
  const praise = Math.min(S.praiseCap, (m.p2Praise || 0) * S.praise)

  const items = { solved, firstResp, avgResp, timeliness, closure, satisfaction }
  const base = scale(Object.values(items))
  const D = P.deduction
  const deduction = Math.min(
    D.cap,
    (m.p2Ignored1h || 0) * D.ignored1h + (m.p2Ignored2h || 0) * D.ignored2h + (m.p2HandoverMiss || 0) * D.handoverMiss +
    (m.p2WrongInfo || 0) * D.wrongInfo + (m.p2Violation ? D.violation : 0)
  )
  const score = r1(Math.max(0, base + vol.bonus + praise - deduction))
  const g = getGrade(score, R.grades, complaints, !!m.p2Violation)
  const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
  return {
    score, base: r1(base), bonus: vol.bonus, praise, deduction, grade: g.grade, coeff: g.coeff,
    items: { solved: roundItem(solved), firstResp: roundItem(firstResp), avgResp: roundItem(avgResp), timeliness: roundItem(timeliness), closure: roundItem(closure), satisfaction: roundItem(satisfaction) },
    source: 'ai', threadCnt, roomCnt: wg.roomCnt, teamAvgCnt: r1(teamAvg), avgFirstSec: mean(firsts), avgReplySec: mean(avgs),
    weightedCnt: r1(weightedCnt), resolvedCnt, unresolvedCnt, handedCnt, unknownCnt, closureRate: closureRate === null ? null : r1(closureRate), avgResolveSec: mean(resolveSecs)
  }
}

export function calcTech(R: TechRules, d: KpiInputs, manual: Record<string, ManualEntry>, group: GroupStats): TechKpiResult[] {
  // 大报表里没有、但有群会话的人补一行（第一项按无数据处理）
  const ids = new Set(d.report.map((r) => r.sys_user_id))
  const extra: SsReportRow[] = Object.entries(group)
    .filter(([k]) => !ids.has(Number(k)))
    .map(([k, v]) => ({ sys_user_id: Number(k), nickname: v.name, email: '', start_session_pv: 0, avg_fst_replay_time: 0, avg_replay_time: 0, is_invit_pv: 0, is_score_pv: 0, sum_score: 0, fst_reply_session_cnt: 0 }))
  const groupCnt = (uid: number): number => group[String(uid)]?.threads.length || 0
  const rows = [...d.report, ...extra].filter((r) => (r.start_session_pv || 0) + groupCnt(r.sys_user_id) > 0 && d.assessed.has(r.sys_user_id))

  const starOf = (r: SsReportRow): { sum: number; cnt: number; deduct: number } => {
    const ex = d.badExempt[String(r.sys_user_id)]
    const rawCnt = r.is_score_pv || 0
    const deduct = Math.min(ex?.cnt || 0, rawCnt)
    return { sum: Math.max(0, (r.sum_score || 0) - (ex?.sumStar || 0)), cnt: rawCnt - deduct, deduct }
  }

  const p1Rows = rows.filter((r) => (r.start_session_pv || 0) > 0)
  const p2Rows = rows.filter((r) => groupCnt(r.sys_user_id) > 0)
  const teamAvg1 = teamAverage(p1Rows.map((r) => [d.shiftOf(r.sys_user_id), r.start_session_pv || 0]))
  // 团队平均：用难度加权后的问题数
  const weighted = (uid: number): number => (group[String(uid)]?.threads || []).reduce((s, t) => s + difficultyWeight(R.part2, t.difficulty), 0)
  const teamAvg2 = teamAverage(p2Rows.map((r) => [d.shiftOf(r.sys_user_id), weighted(r.sys_user_id)]))
  const ts = p1Rows.map(starOf).reduce((a, s) => ({ sum: a.sum + s.sum, cnt: a.cnt + s.cnt }), { sum: 0, cnt: 0 })
  const teamStar = ts.cnt > 0 ? ts.sum / ts.cnt : null

  return rows.map((r): TechKpiResult => {
    const uid = r.sys_user_id
    const key = String(uid)
    const shift = d.shiftOf(uid)
    const isNight = shift === 'night'
    const m: ManualEntry = manual[key] || {}
    const ai = d.ai[key]
    const p1 = p1Rows.includes(r)
      ? calcPart1(r, R, m, isNight, { teamAvg: teamAvg1, star: starOf(r), teamStar, reply: d.reply[key], ai: ai ? { avg: ai.avg, count: ai.count } : null })
      : null
    const wg = group[key]
    const p2 = wg && wg.threads.length ? calcPart2(R, m, isNight, wg, teamAvg2) : null

    const T = R.total
    let num = 0
    let den = 0
    if (p1) { num += p1.score * T.part1Weight; den += T.part1Weight }
    if (p2) { num += p2.score * T.part2Weight; den += T.part2Weight }
    const partScore = den > 0 ? (num / den) * ((T.part1Weight + T.part2Weight) / 100) : 0
    const supervisorDefaulted = m.supervisorScore == null
    const supervisorScore = Math.min(T.supervisorMax, Math.max(0, m.supervisorScore ?? T.supervisorDefault))
    const finalScore = r1(partScore + supervisorScore)
    const star = !!p1 && !!p2 && p1.score >= R.star.partMin && p2.score >= R.star.partMin && finalScore >= R.star.totalMin
    const online = d.online[key]
    return {
      sysUserId: uid,
      name: d.nameOf(uid, r.nickname),
      shiftLabel: d.shiftLabel(shift),
      isNight,
      p1, p2,
      supervisorScore,
      supervisorNote: m.supervisorNote || '',
      supervisorDefaulted,
      finalScore,
      star,
      loginSec: online?.login_duration || 0,
      onlineSec: online?.online_duration || 0,
      busySec: online?.busy_duration || 0
    }
  }).sort((a, b) => b.finalScore - a.finalScore)
}
