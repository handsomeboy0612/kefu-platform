import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, DatePicker, RadioGroup, Radio, Select, Spin, Toast } from '@douyinfe/semi-ui'
import { api } from '../../api'
import { useAuth } from '../../auth'
import PageHeader from '../../components/PageHeader'
import SessionDrawer from '../../components/SessionDrawer'
import type { SessionItem } from '../SessionsPage'
import { fmtTime } from '../../utils'
import CsTable from './CsTable'
import TechTable from './TechTable'
import ExemptModal, { type ExemptTarget } from './ExemptModal'
import ManualModal from './ManualModal'
import { pct, type CsResult, type KpiReport, type ManualEntry, type TechResult } from './types'

interface SnapshotMeta { id: number; begin: number; end: number; createdBy: string; createdAt: number; count: number }
interface Coverage { total: number; scored: number; eligible: number }

const startOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000)
const endOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime() / 1000)
const day = (sec: number): string => fmtTime(sec).slice(0, 10)

type Preset = 'month' | 'lastMonth' | 'custom'
function presetRange(p: Preset): [Date, Date] {
  const t = new Date()
  if (p === 'lastMonth') return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]
  return [new Date(t.getFullYear(), t.getMonth(), 1), t]
}

/** 导出 CSV（Excel 能直接打开）；带 BOM 防中文乱码 */
function exportCsv(report: KpiReport, deptName: string): void {
  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  let head: string[]
  let rows: unknown[][]
  if (report.template === 'cs') {
    head = ['排名', '客服', '班次', '接待量', '日均', '团队日均', '接待分', '回复率', '回复分', '星级均分', '参评数', '满意度分', '首响(秒)', '均响(秒)', '响应分', 'AI中位数', 'AI评分数', 'AI分', '综合分', '等级', '系数']
    rows = (report.results as CsResult[]).map((r, i) => [i + 1, r.name, r.shiftLabel, r.sessionCnt, r.dailyAvgCnt, r.teamAvgCnt, r.sessionScore,
      pct(r.replyRate), r.replyScore, r.avgStar < 0 ? '' : r.avgStar, r.scoredCnt, r.satisfyScore, r.avgResponseSec, r.avgReplySec, r.responseScore,
      r.aiAvgScore ?? '', r.aiScoredCount, r.aiComponent, r.finalScore, r.grade, r.coeff])
  } else {
    head = ['排名', '客服', '班次', '第一项', '第一项等级', '接待量', '星级均分', '回复率', 'AI均分', '第二项', '第二项等级', '群会话', '主管评分', '主管评语', '总KPI', '卓越之星']
    rows = (report.results as TechResult[]).map((r, i) => [i + 1, r.name, r.shiftLabel, r.p1?.score ?? '', r.p1?.grade ?? '', r.p1?.sessionCnt ?? '',
      r.p1 && r.p1.avgStar >= 0 ? r.p1.avgStar : '', r.p1 ? pct(r.p1.replyRate) : '', r.p1?.aiAvgScore ?? '', r.p2?.score ?? '', r.p2?.grade ?? '',
      r.p2?.threadCnt ?? '', r.supervisorScore, r.supervisorNote, r.finalScore, r.star ? '是' : ''])
  }
  const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = `${deptName}绩效_${day(report.begin)}_${day(report.end)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

const KpiPage: React.FC = () => {
  const { dept } = useAuth()
  const [preset, setPreset] = useState<Preset>('month')
  const [range, setRange] = useState<[Date, Date]>(presetRange('month'))
  const [report, setReport] = useState<KpiReport | null>(null)
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [viewing, setViewing] = useState<number | ''>('')
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [loading, setLoading] = useState(false)
  const [exempt, setExempt] = useState<ExemptTarget | null>(null)
  const [manualFor, setManualFor] = useState<TechResult | null>(null)
  const [manual, setManual] = useState<Record<string, ManualEntry>>({})
  const [detail, setDetail] = useState<SessionItem | null>(null)

  const begin = startOfDay(range[0])
  const end = endOfDay(range[1])

  const loadSnapshots = useCallback(() => {
    if (!dept) return
    api<SnapshotMeta[]>('/api/kpi/snapshots', { query: { dept: dept.code } }).then(setSnapshots).catch(() => setSnapshots([]))
  }, [dept])
  useEffect(loadSnapshots, [loadSnapshots])

  useEffect(() => {
    if (!dept) return
    setCoverage(null)
    api<Coverage>('/api/kpi/coverage', { query: { dept: dept.code, begin, end } }).then(setCoverage).catch(() => setCoverage(null))
  }, [dept, begin, end])

  const calculate = useCallback(async (b = begin, e = end): Promise<void> => {
    if (!dept) return
    setLoading(true)
    try {
      const r = await api<KpiReport>('/api/kpi/calculate', { body: { begin: b, end: e }, query: { dept: dept.code } })
      setReport(r)
      setViewing('')
      loadSnapshots()
      Toast.success(`已算出 ${r.results.length} 人的绩效`)
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [dept, begin, end, loadSnapshots])

  const openSnapshot = async (id: number | ''): Promise<void> => {
    setViewing(id)
    if (!dept || id === '') { setReport(null); return }
    setLoading(true)
    try {
      setReport(await api<KpiReport>(`/api/kpi/snapshots/${id}`, { query: { dept: dept.code } }))
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 改了剔除 / 人工录入后按报表原来的时段重算
  const recalc = (): void => { if (report) void calculate(report.begin, report.end) }

  const openManual = async (r: TechResult): Promise<void> => {
    if (!dept || !report) return
    try {
      setManual(await api<Record<string, ManualEntry>>('/api/kpi/manual', { query: { dept: dept.code, month: report.month } }))
      setManualFor(r)
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }

  const summary = useMemo(() => {
    if (!report) return null
    const scores = report.results.map((r) => r.finalScore)
    const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0
    const grades: Record<string, number> = {}
    if (report.template === 'cs') for (const r of report.results as CsResult[]) grades[r.grade] = (grades[r.grade] || 0) + 1
    else for (const r of report.results as TechResult[]) if (r.p1) grades[r.p1.grade] = (grades[r.p1.grade] || 0) + 1
    return { avg, grades }
  }, [report])

  if (!dept) return null
  const live = viewing === ''
  const lowAi = coverage && coverage.eligible > 0 && coverage.scored / coverage.eligible < 0.5

  return (
    <div className="page">
      <PageHeader
        title="绩效考核"
        desc={dept.kpiTemplate === 'tech'
          ? '总 KPI = 第一项 · 客服接待 + 第二项 · 对公群技术售后 + 主管评分。规则在「设置 → 考核规则」。'
          : '综合分 = 接待量 + 人工回复率 + 客户满意度 + 响应速度 + AI 对话质量。规则在「设置 → 考核规则」。'}
        scope={dept.name}
        scopeHint="只算本部门勾了「参与考核」的客服 · 接待量、满意度、响应速度取自 SaleSmartly 报表，按分配时间统计"
      />

      <div className="panel filter-panel">
        <div className="filter-item">
          <span className="form-label">考核时段</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <RadioGroup type="button" value={preset} onChange={(e) => {
              const p = e.target.value as Preset
              setPreset(p)
              if (p !== 'custom') setRange(presetRange(p))
            }}>
              <Radio value="month">本月</Radio>
              <Radio value="lastMonth">上月</Radio>
              <Radio value="custom">自定义</Radio>
            </RadioGroup>
            {preset === 'custom' && (
              <DatePicker type="dateRange" value={range} style={{ width: 260 }}
                onChange={(v) => { if (Array.isArray(v) && v[0] && v[1]) setRange([v[0] as Date, v[1] as Date]) }} />
            )}
            <span className="form-hint" style={{ margin: 0 }}>{day(begin)} ~ {day(end)}</span>
          </div>
        </div>
        <div className="filter-item">
          <span className="form-label">&nbsp;</span>
          <Button theme="solid" loading={loading && live} onClick={() => void calculate()}>生成报表</Button>
        </div>
        <div className="filter-item" style={{ marginLeft: 'auto' }}>
          <span className="form-label">历史报表</span>
          <Select
            value={viewing}
            onChange={(v) => void openSnapshot(v === '' || v === undefined ? '' : Number(v))}
            style={{ width: 300 }}
            optionList={[
              { value: '', label: '—（看刚生成的）' },
              ...snapshots.map((s) => ({ value: s.id, label: `${day(s.begin)} ~ ${day(s.end)} · ${s.count} 人 · ${fmtTime(s.createdAt).slice(5)} ${s.createdBy}` }))
            ]}
          />
        </div>
      </div>

      {coverage && live && (
        <div className={`notice ${lowAi && dept.kpiTemplate === 'cs' ? 'error' : ''}`} style={{ marginTop: 0 }}>
          这个时段本部门有 {coverage.total} 个会话，参与考核、客户说过话的 {coverage.eligible} 个，已 AI 评分 {coverage.scored} 个
          （{coverage.eligible ? Math.round((coverage.scored / coverage.eligible) * 100) : 0}%）。
          {dept.kpiTemplate === 'cs'
            ? lowAi ? '没有 AI 评分的客服「AI 质量」记 0 分（占 25 分），建议先到「会话记录」按这个时段批量评分再生成。' : ''
            : '第一项的 AI 对话质量没有评分时按过渡期规则，把它的分值加给接待量 / 满意度 / 响应速度。'}
        </div>
      )}

      {loading && !report && <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>}
      {!report && !loading && (
        <div className="panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div className="form-hint">选好考核时段，点「生成报表」。每次生成都会存一份，以后可以在「历史报表」里回看。</div>
        </div>
      )}

      {report && summary && (
        <div className="stack" style={{ opacity: loading ? 0.6 : 1 }}>
          <div className="list-toolbar">
            <div className="footnote">
              {live ? '刚生成' : '历史报表'}：{day(report.begin)} ~ {day(report.end)}，{report.results.length} 人，平均 {summary.avg} 分；
              等级 {Object.entries(summary.grades).sort(([a], [b]) => 'SABCD'.indexOf(a) - 'SABCD'.indexOf(b)).map(([g, n]) => `${g} ${n} 人`).join('、') || '—'}。
              生成于 {fmtTime(report.createdAt)} · {report.createdBy}
              {report.excluded.length ? `。没算进来的：${report.excluded.map((x) => `${x.name}（${x.reason}）`).join('、')}` : ''}
            </div>
            <Button style={{ marginLeft: 'auto' }} onClick={() => exportCsv(report, dept.name)}>导出 Excel（CSV）</Button>
          </div>
          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            {report.template === 'cs'
              ? <CsTable results={report.results as CsResult[]} rules={report.rules} onExempt={live ? setExempt : undefined} />
              : <TechTable results={report.results as TechResult[]} rules={report.rules} onExempt={live ? setExempt : undefined} onManual={live ? (r) => void openManual(r) : undefined} />}
          </div>
          {!live && <div className="form-hint" style={{ margin: 0 }}>历史报表只能看；要剔除差评、改人工录入，请重新生成这个时段的报表。</div>}
        </div>
      )}

      <ExemptModal
        deptCode={dept.code}
        target={exempt}
        range={report ? { begin: report.begin, end: report.end } : null}
        onClose={(changed) => { setExempt(null); if (changed) recalc() }}
        onOpenSession={(sessionId) => {
          // 详情抽屉只需要会话 ID 去拉聊天记录，其余字段由接口返回后显示
          setDetail({ sessionId, customerName: '', chatUserId: '', sysUserId: 0, memberName: '', participate: true, channel: 0, startTime: 0, endTime: 0, starScore: 0, msgCount: 0, customerMsgCount: 0, staffMsgCount: 0, scoreStatus: 'none', aiTotal: null, aiGrade: '', aiReviewed: false })
        }}
      />
      {manualFor && report && (
        <ManualModal
          deptCode={dept.code}
          month={report.month}
          person={{ sysUserId: manualFor.sysUserId, name: manualFor.name }}
          initial={manual[String(manualFor.sysUserId)] || {}}
          rules={report.rules}
          onClose={(saved) => { setManualFor(null); if (saved) recalc() }}
        />
      )}
      <SessionDrawer deptCode={dept.code} session={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

export default KpiPage
