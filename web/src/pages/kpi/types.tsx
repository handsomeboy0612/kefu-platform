/** 绩效考核页用到的类型（和服务端 kpi/calc-*.ts 对应） */

export interface KpiItem { score: number | null; full: number }

export interface CsResult {
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
  finalScore: number
  grade: string
  coeff: number
}

export interface TechPart1 {
  score: number; base: number; bonus: number; deduction: number; grade: string; coeff: number; transitionApplied: boolean
  items: Record<'sessions' | 'firstResp' | 'avgResp' | 'satisfaction' | 'aiQuality' | 'replyRate', KpiItem>
  sessionCnt: number; teamAvgCnt: number; avgResponseSec: number; avgReplySec: number; respNoData: boolean
  avgStar: number; usedStar: number | null; teamStar: number | null; scoredCnt: number; badReviewDeducted: number
  replyRate: number; replyNum: number; replyDen: number; replyGraced: number
  aiAvgScore: number | null; aiScoredCount: number
}

export interface TechPart2 {
  score: number; base: number; bonus: number; praise: number; deduction: number; grade: string; coeff: number
  items: Record<'solved' | 'firstResp' | 'avgResp' | 'timeliness' | 'closure' | 'satisfaction', KpiItem>
  threadCnt: number; roomCnt: number; teamAvgCnt: number; avgFirstSec: number | null; avgReplySec: number | null
  /** ai = 按群问题算；rule = 按规则群会话算（老快照没有这个字段，按 rule） */
  source?: 'ai' | 'rule'
  resolvedCnt?: number; unresolvedCnt?: number; unknownCnt?: number; closureRate?: number | null; avgResolveSec?: number | null
}

export interface TechResult {
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
}

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

export interface KpiReport {
  template: 'cs' | 'tech'
  begin: number
  end: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rules: any
  results: Array<CsResult | TechResult>
  excluded: Array<{ sysUserId: number; name: string; reason: string }>
  month: string
  replyUncached: number
  createdAt: number
  createdBy: string
}

export const fmtSec = (s: number | null | undefined): string => {
  if (s == null) return '—'
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r ? `${m}分${r}秒` : `${m}分`
}

export const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** 等级配色（S / A / B / C） */
export const KPI_GRADE_STYLE: Record<string, { bg: string; color: string }> = {
  S: { bg: '#E8F3EC', color: '#2F6B47' },
  A: { bg: '#ECEDF8', color: '#0C1754' },
  B: { bg: '#FBF1DF', color: '#8A5A0B' },
  C: { bg: '#F8E9E5', color: '#9C3B26' }
}

export const KpiGrade: React.FC<{ grade: string; coeff?: number }> = ({ grade, coeff }) => {
  const st = KPI_GRADE_STYLE[grade] || KPI_GRADE_STYLE.C
  return <span className="pill-tag" style={{ background: st.bg, color: st.color, fontWeight: 600 }}>{grade}{coeff != null ? ` ×${coeff}` : ''}</span>
}

import React from 'react'
