/**
 * 客服部绩效计算（桌面版 main 分支 kpi-service 原样搬过来，去掉了企微存档并入）。
 * 综合分 = 接待量 + 回复率 + 满意度 + 响应速度 + AI 质量；通宵班不算接待量，响应速度走专用阶梯。
 */
import type { CsRules, NightResponseTier, ResponseTier } from './rules'
import type { KpiInputs } from './inputs'

const r1 = (n: number): number => Math.round(n * 10) / 10

export interface CsKpiResult {
  sysUserId: number
  name: string
  shiftLabel: string
  isNight: boolean
  sessionScore: number
  replyScore: number
  satisfyScore: number
  responseScore: number
  firstRespScore: number
  avgRespScore: number
  aiComponent: number
  kpiTotal: number
  sessionCnt: number
  teamAvgCnt: number
  activeDays: number
  dailyAvgCnt: number
  replyRate: number
  replyNum: number
  replyDen: number
  replyGraced: number
  replyLocal: boolean
  replyUncached: number
  avgStar: number
  invitedCnt: number
  scoredCnt: number
  graceApplied: boolean
  avgResponseSec: number
  avgReplySec: number
  respNoData: boolean
  aiAvgScore: number | null
  aiScoredCount: number
  aiCoverage: number
  badReviewDeducted: number
  loginSec: number
  onlineSec: number
  busySec: number
  finalScore: number
  grade: string
  coeff: number
}

function sessionScore(cnt: number, avg: number, R: CsRules): number {
  const w = R.weights.sessions
  if (w <= 0) return 0
  if (avg === 0) return w
  if (cnt >= avg * R.sessions.bonusRatio) return w + R.sessions.bonusExtra
  if (cnt >= avg) return w
  return r1((cnt / avg) * w)
}

function replyScore(replied: number, total: number, R: CsRules): number {
  const w = R.weights.replyRate
  if (w <= 0 || total === 0) return 0
  const { fullRate, midRate, midPercent } = R.replyRate
  const rate = replied / total
  if (rate >= fullRate / 100) return w
  if (rate >= midRate / 100) return r1(w * (midPercent / 100))
  return r1(rate * w * (midPercent / 100))
}

function nightReplyScore(replied: number, total: number, R: CsRules): number {
  const w = R.weights.replyRate
  if (w <= 0 || total === 0) return 0
  const { fullRate, midRate, midPercent } = R.night.replyRate
  const rate = replied / total
  if (rate >= fullRate / 100) return w
  if (rate >= midRate / 100) return r1(w * (midPercent / 100))
  return 0
}

/** 满意度：参评不足 minReviews 宽限满分；锚点随 fullStar 平移（默认 4.75~4.9 → 30~35 分） */
function satisfyScore(sum: number, cnt: number, R: CsRules): { score: number; avgStar: number; grace: boolean } {
  const w = R.weights.satisfaction
  const fs = R.satisfaction.fullStar
  if (cnt <= 0) return { score: w, avgStar: -1, grace: true }
  const avg = sum / cnt
  if (cnt < R.satisfaction.minReviews) return { score: w, avgStar: Math.round(avg * 100) / 100, grace: true }
  let s: number
  if (w <= 0) s = 0
  else if (avg >= fs) s = w
  else if (avg >= fs - 0.15) s = w * (6 / 7) + ((avg - (fs - 0.15)) / 0.15) * w * (1 / 7)
  else if (avg >= fs - 0.4) s = w * (5 / 7) + ((avg - (fs - 0.4)) / 0.25) * w * (1 / 7)
  else s = (avg / (fs - 0.4)) * w * (5 / 7)
  return { score: r1(s), avgStar: Math.round(avg * 100) / 100, grace: false }
}

function matchTier(sec: number, tiers: ResponseTier[], full: number): number {
  if (full <= 0) return 0
  for (const t of [...tiers].sort((a, b) => a.maxSec - b.maxSec)) if (sec <= t.maxSec) return r1(full * (t.percent / 100))
  return 0
}

function matchNightTier(sec: number, tiers: NightResponseTier[]): number {
  for (const t of [...tiers].sort((a, b) => a.maxSec - b.maxSec)) if (sec <= t.maxSec) return t.score
  return 0
}

function grade(score: number, R: CsRules): { grade: string; coeff: number } {
  const sorted = [...R.grades].sort((a, b) => b.min - a.min)
  for (const g of sorted) if (score >= g.min) return { grade: g.label, coeff: g.coeff }
  const last = sorted[sorted.length - 1]
  return { grade: last?.label || 'C', coeff: last?.coeff ?? 0.8 }
}

export function calcCs(R: CsRules, d: KpiInputs): CsKpiResult[] {
  // 参与考核的人：本部门、参与考核、还在项目里、本期有接待
  const rows = d.report.filter((r) => (r.start_session_pv || 0) > 0 && d.assessed.has(r.sys_user_id))
  const daysOf = (uid: number): number => d.activeDays[String(uid)] || d.periodDays

  // 团队日均基准：只算白 / 晚班（排除通宵班）
  const dayCnts = rows.filter((r) => d.shiftOf(r.sys_user_id) !== 'night').map((r) => (r.start_session_pv || 0) / daysOf(r.sys_user_id))
  const teamAvg = dayCnts.length ? dayCnts.reduce((a, b) => a + b, 0) / dayCnts.length : 0

  return rows.map((r): CsKpiResult => {
    const uid = r.sys_user_id
    const key = String(uid)
    const shift = d.shiftOf(uid)
    const isNight = shift === 'night'
    const sessionCnt = r.start_session_pv || 0
    const replyedCnt = r.fst_reply_session_cnt || 0
    const firstSec = Math.round(r.avg_fst_replay_time || 0)
    const replySec = Math.round(r.avg_replay_time || 0)
    // 一条都没回复过时两个均值是 0，不能当成「0 秒」拿满分
    const respNoData = replyedCnt === 0

    const ex = d.badExempt[key]
    const rawScored = r.is_score_pv || 0
    const deduct = Math.min(ex?.cnt || 0, rawScored)
    const scoredCnt = rawScored - deduct
    const sumScore = Math.max(0, (r.sum_score || 0) - (ex?.sumStar || 0))
    const sat = satisfyScore(sumScore, scoredCnt, R)

    const rs = d.reply[key]
    const replyLocal = !!rs && rs.den > 0
    const replyNum = replyLocal ? rs.num : replyedCnt
    const replyDen = replyLocal ? rs.den : sessionCnt

    const days = daysOf(uid)
    const dailyAvg = sessionCnt / days
    const sScore = isNight ? 0 : sessionScore(dailyAvg, teamAvg, R)
    const rScore = isNight ? nightReplyScore(replyNum, replyDen, R) : replyScore(replyNum, replyDen, R)
    let first = 0
    let avg = 0
    if (!respNoData) {
      if (isNight) {
        first = matchNightTier(firstSec, R.night.responseTiers)
        avg = matchNightTier(replySec, R.night.avgResponseTiers)
      } else if (R.weights.response > 0) {
        first = matchTier(firstSec, R.response.tiers, R.response.firstScore)
        avg = matchTier(replySec, R.response.avgTiers, R.response.avgScore)
      }
    }
    const responseScore = r1(first + avg)
    const kpiTotal = r1(sScore + rScore + sat.score + responseScore)

    // AI 质量：中位数 ≥ fullThreshold 满分，否则按比例；没有评分按 0
    const ai = d.ai[key]
    const aiAvgScore = ai ? r1(ai.median) : null
    const aiFull = R.weights.aiQuality
    const aiComponent = aiAvgScore !== null && aiFull > 0 ? Math.min(r1((aiAvgScore / R.aiQuality.fullThreshold) * aiFull), aiFull) : 0
    const finalScore = r1(kpiTotal + aiComponent)
    const g = grade(finalScore, R)
    const online = d.online[key]

    return {
      sysUserId: uid,
      name: d.nameOf(uid, r.nickname),
      shiftLabel: d.shiftLabel(shift),
      isNight,
      sessionScore: sScore,
      replyScore: rScore,
      satisfyScore: sat.score,
      responseScore,
      firstRespScore: first,
      avgRespScore: avg,
      aiComponent,
      kpiTotal,
      sessionCnt,
      teamAvgCnt: r1(teamAvg),
      activeDays: days,
      dailyAvgCnt: r1(dailyAvg),
      replyRate: replyDen > 0 ? replyNum / replyDen : 0,
      replyNum,
      replyDen,
      replyGraced: rs?.graced ?? 0,
      replyLocal,
      replyUncached: rs?.uncached ?? 0,
      avgStar: sat.avgStar,
      invitedCnt: r.is_invit_pv || 0,
      scoredCnt,
      graceApplied: sat.grace,
      avgResponseSec: firstSec,
      avgReplySec: replySec,
      respNoData,
      aiAvgScore,
      aiScoredCount: ai?.count ?? 0,
      aiCoverage: sessionCnt > 0 ? Math.min((ai?.count ?? 0) / sessionCnt, 1) : 0,
      badReviewDeducted: deduct,
      loginSec: online?.login_duration || 0,
      onlineSec: online?.online_duration || 0,
      busySec: online?.busy_duration || 0,
      finalScore,
      grade: g.grade,
      coeff: g.coeff
    }
  }).sort((a, b) => b.finalScore - a.finalScore)
}
