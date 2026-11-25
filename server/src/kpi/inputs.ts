/**
 * 绩效计算的输入：SaleSmartly 大报表 + 在线时长报表 + 平台本地数据（成员、回复率、AI、剔除、出勤）。
 * 「参与考核」只认平台成员表：本部门、勾了参与考核、还在 SaleSmartly 项目里。
 */
import { query } from '../db'
import type { Department } from '../auth'
import { getDeptSetting } from '../settings'
import { autoShift, SHIFT_LABELS, type MemberRow, type ShiftKey } from '../members'
import { describeFetchError, SalesmartlyClient, type SsOnlineRow, type SsReportRow } from '../services/salesmartly'
import { activeDays, aiScores, badReviewExempts, replyStats, type ReplyStat } from './data'

/** SaleSmartly 报表拉不到（网络 / 鉴权），和平台自己的错误分开 */
export class SsReportError extends Error {}

export interface KpiInputs {
  report: SsReportRow[]
  online: Record<string, SsOnlineRow>
  assessed: Set<number>
  /** 时段内参与考核、但被排除的人数及原因（页面提示用） */
  excluded: Array<{ sysUserId: number; name: string; reason: string }>
  shiftOf: (uid: number) => ShiftKey
  shiftLabel: (k: ShiftKey) => string
  nameOf: (uid: number, fallback: string) => string
  reply: Record<string, ReplyStat>
  ai: Record<string, { median: number; avg: number; count: number }>
  badExempt: Record<string, { cnt: number; sumStar: number }>
  activeDays: Record<string, number>
  periodDays: number
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const ymd = (sec: number): string => {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function loadInputs(dept: Department, projectId: string, begin: number, end: number, replyGraceSec: number): Promise<KpiInputs> {
  const cfg = await getDeptSetting(dept.code, 'salesmartly')
  const client = new SalesmartlyClient(cfg)
  const startDate = ymd(begin)
  const endDate = ymd(end)
  let report: SsReportRow[]
  let onlineRows: SsOnlineRow[]
  try {
    ;[report, onlineRows] = await Promise.all([
      client.fetchBigReport(startDate, endDate),
      // 在线时长只做参考，拉不到不影响计分
      client.fetchOnlineDurationReport(startDate, endDate).catch(() => [] as SsOnlineRow[])
    ])
  } catch (err) {
    throw new SsReportError(`拉 SaleSmartly 报表失败：${describeFetchError(err)}`)
  }

  const members = await query<MemberRow>('SELECT * FROM members WHERE project_id = ?', [projectId])
  const byUid = new Map(members.map((m) => [Number(m.sys_user_id), m]))
  const assessed = new Set<number>()
  const excluded: KpiInputs['excluded'] = []
  for (const r of report) {
    if (!(r.start_session_pv > 0)) continue
    const m = byUid.get(r.sys_user_id)
    if (!m || m.department_id !== dept.id) continue // 别的部门的人，不提
    const name = m.nickname || r.nickname
    if (!m.active) excluded.push({ sysUserId: r.sys_user_id, name, reason: '已不在 SaleSmartly 项目' })
    else if (!m.participate) excluded.push({ sysUserId: r.sys_user_id, name, reason: '没勾参与考核' })
    else assessed.add(r.sys_user_id)
  }
  // 只在对公群接待、大报表里没有的人（第 6 步）也要能进：本部门参与考核的都放进集合
  for (const m of members) if (m.department_id === dept.id && m.participate && m.active) assessed.add(Number(m.sys_user_id))

  const [reply, ai, badExempt, days] = await Promise.all([
    replyStats(projectId, begin, end, replyGraceSec),
    aiScores(projectId, begin, end),
    badReviewExempts(projectId, begin, end),
    activeDays(projectId, begin, end)
  ])

  return {
    report,
    online: Object.fromEntries(onlineRows.map((o) => [String(o.sys_user_id), o])),
    assessed,
    excluded,
    shiftOf: (uid) => {
      const m = byUid.get(uid)
      return m ? (m.shift || autoShift(m.group_names)) : 'unknown'
    },
    shiftLabel: (k) => SHIFT_LABELS[k] || '未分组',
    nameOf: (uid, fallback) => byUid.get(uid)?.nickname || fallback || String(uid),
    reply,
    ai,
    badExempt,
    activeDays: days,
    periodDays: Math.max(1, Math.round((end - begin) / 86400))
  }
}
