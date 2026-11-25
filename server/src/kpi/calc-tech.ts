/**
 * 技术支持部绩效计算（桌面版 feat/sessions-total-count 的 kpi-service 原样搬过来，去掉了企微存档并入）。
 * 总 KPI = 第一项·客服接待 × part1Weight% + 第二项·对公群技术售后 × part2Weight% + 主管评分。
 * 某一小项没数据就不计分，大项得分 = 实际得分 ÷ 能考核小项的满分合计 × 100；加分扣分在折算后统一加减。
 *
 * 第二项（对公群）要等对公群同步搬过来（一期第 6 步）才有数据，现在 groupStats 为空，第二项按「不考核」处理，
 * 总 KPI 按第一项折算（和桌面版缺一项时的算法一样）。
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
  threadCnt: number
  roomCnt: number
  teamAvgCnt: number
  avgFirstSec: number | null
  avgReplySec: number | null
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

/** 对公群每人的群会话（第 6 步接上） */
export type GroupStats = Record<string, { name: string; roomCnt: number; threads: Array<{ firstSec: number | null; avgSec: number | null }> }>

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
  const vol = volumePct(threadCnt, teamAvg, isNight ? P.solved.night : P.solved.dayEvening)
  const solved: KpiItem = { full: w.solved, score: (vol.pct / 100) * w.solved }

  const firsts = wg.threads.map((t) => t.firstSec).filter((s): s is number => s !== null)
  const avgs = wg.threads.map((t) => t.avgSec).filter((s): s is number => s !== null)
  const meanPct = (secs: number[], tiers: ResponseTier[]): number | null =>
    secs.length ? secs.reduce((s, sec) => s + tierPct(sec, tiers), 0) / secs.length : null
  const fp = meanPct(firsts, P.firstRespTiers)
  const ap = meanPct(avgs, P.avgRespTiers)
  const firstResp: KpiItem = { full: w.firstResp, score: fp === null ? null : (fp / 100) * w.firstResp }
  const avgResp: KpiItem = { full: w.avgResp, score: ap === null ? null : (ap / 100) * w.avgResp }
  // 处理时效、问题闭环率：问题登记（二期 AI 分问题）上线前没有数据，不计分
  const timeliness: KpiItem = { full: w.timeliness, score: null }
  const closure: KpiItem = { full: w.closure, score: null }

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
    items: { solved: roundItem(solved), firstResp: roundItem(firstResp), avgResp: roundItem(avgResp), timeliness, closure, satisfaction: roundItem(satisfaction) },
    threadCnt, roomCnt: wg.roomCnt, teamAvgCnt: r1(teamAvg), avgFirstSec: mean(firsts), avgReplySec: mean(avgs)
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
  const teamAvg2 = teamAverage(p2Rows.map((r) => [d.shiftOf(r.sys_user_id), groupCnt(r.sys_user_id)]))
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
