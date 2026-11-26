import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Checkbox, DatePicker, RadioGroup, Radio, Spin, Table, Toast } from '@douyinfe/semi-ui'
import { api } from '../api'
import { useAuth } from '../auth'
import PageHeader from '../components/PageHeader'
import { C_BAD, C_GOOD, DivergingBars, DivergingColumns, HBars, Legend, LineChart } from '../components/charts'
import { GRADES } from '../constants'
import { fmtSec } from './kpi/types'

interface Agg {
  sessions: number
  spoke: number
  reviewed: number
  avgStar: number | null
  good: number
  mid: number
  bad: number
  aiCount: number
  aiAvg: number | null
  aiGoodRate: number | null
}

/** 对公群（AI 整理的群问题，口径和绩效第二项一致） */
interface GroupAgg {
  issues: number; resolved: number; unresolved: number; handed: number; unknown: number
  closureRate: number | null; avgFirstSec: number | null; avgResolveSec: number | null
}

interface Dashboard {
  group: { summary: GroupAgg; daily: Array<GroupAgg & { date: string }>; byMember: Array<GroupAgg & { sysUserId: number; name: string; participate: boolean }> } | null
  summary: Agg
  daily: Array<Agg & { date: string }>
  byMember: Array<Agg & { sysUserId: number; name: string; participate: boolean }>
  grades: Array<{ grade: string; count: number }>
}

const startOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000)
const endOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime() / 1000)
const md = (s: string): string => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`

type Preset = '7' | '30' | 'month' | 'lastMonth' | 'custom'

function presetRange(p: Preset): [Date, Date] {
  const t = new Date()
  if (p === '7') return [new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6), t]
  if (p === '30') return [new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29), t]
  if (p === 'lastMonth') return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]
  return [new Date(t.getFullYear(), t.getMonth(), 1), t]
}

const StatTile: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode }> = ({ label, value, sub }) => (
  <div className="stat-item">
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
)

/** 对公群：AI 整理的群问题（只算本部门的人处理的，按客户第一次提问的时间算在哪天，和绩效第二项一致） */
const GroupSection: React.FC<{ g: NonNullable<Dashboard['group']> }> = ({ g }) => {
  const t = g.summary
  const cols = [
    { title: '处理人', dataIndex: 'name', render: (v: string, r: GroupAgg & { participate: boolean }) => <span>{v}{!r.participate && <span className="form-hint" style={{ margin: '0 0 0 6px' }}>不参与考核</span>}</span> },
    { title: '群问题', dataIndex: 'issues', width: 90, align: 'right' as const },
    { title: '已解决', dataIndex: 'resolved', width: 90, align: 'right' as const },
    { title: '未解决', dataIndex: 'unresolved', width: 90, align: 'right' as const, render: (v: number) => (v ? <b style={{ color: '#9C3B26' }}>{v}</b> : 0) },
    { title: '交接', dataIndex: 'handed', width: 80, align: 'right' as const },
    { title: '判断不了', dataIndex: 'unknown', width: 100, align: 'right' as const },
    { title: '闭环率', dataIndex: 'closureRate', width: 100, align: 'right' as const, render: (v: number | null) => (v == null ? '—' : `${v}%`) },
    { title: '平均首响', dataIndex: 'avgFirstSec', width: 110, align: 'right' as const, render: (v: number | null) => fmtSec(v) },
    { title: '平均处理时效', dataIndex: 'avgResolveSec', width: 130, align: 'right' as const, render: (v: number | null) => fmtSec(v) }
  ]
  return (
    <>
      <div className="panel-title" style={{ margin: '12px 0 -4px' }}>对公群（AI 整理的群问题）</div>
      <div className="stat-row">
        <StatTile label="群问题" value={t.issues} sub="本部门的人处理的" />
        <StatTile label="已解决" value={t.resolved} sub={`未解决 ${t.unresolved} · 交接 ${t.handed} · 判断不了 ${t.unknown}`} />
        <StatTile label="闭环率" value={t.closureRate == null ? '—' : `${t.closureRate}%`} sub="解决算 1，交接 0.8 / 0.4，判断不了不算" />
        <StatTile label="平均首响" value={fmtSec(t.avgFirstSec)} sub="从被 @ 或客户提问算起" />
        <StatTile label="平均处理时效" value={fmtSec(t.avgResolveSec)} sub="已解决的，从首次响应到解决" />
      </div>
      <div className="dash-grid">
        <div className="panel">
          <div className="panel-title">每日群问题</div>
          <LineChart data={g.daily.map((d) => ({ label: d.date, value: d.issues }))} valueName="群问题" formatX={md} />
          <div className="footnote">按客户第一次提问的时间分到每天；商务等其他部门处理的、没人处理的不算，在「群问题」页看。</div>
        </div>
        <div className="panel">
          <div className="panel-title">每日已解决</div>
          <LineChart data={g.daily.map((d) => ({ label: d.date, value: d.resolved }))} valueName="已解决" formatX={md} />
          <div className="footnote">AI 判断的状态，主管在「群问题」里改过的按改过的算。</div>
        </div>
      </div>
      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px 8px' }} className="panel-title">按人明细（对公群）</div>
        <Table rowKey="sysUserId" columns={cols} dataSource={g.byMember} pagination={false} size="middle" />
      </div>
    </>
  )
}

const DashboardPage: React.FC = () => {
  const { dept } = useAuth()
  const [preset, setPreset] = useState<Preset>('month')
  const [range, setRange] = useState<[Date, Date]>(presetRange('month'))
  const [onlyAssessed, setOnlyAssessed] = useState(true)
  const [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(false)
  const [sortBy, setSortBy] = useState<'bad' | 'good' | 'sessions'>('bad')

  const load = useCallback(async (): Promise<void> => {
    if (!dept) return
    setLoading(true)
    try {
      setData(await api<Dashboard>('/api/dashboard', {
        query: { dept: dept.code, begin: startOfDay(range[0]), end: endOfDay(range[1]), participate: onlyAssessed ? 1 : '' }
      }))
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [dept, range, onlyAssessed])
  useEffect(() => { void load() }, [load])

  const members = useMemo(() => {
    const list = [...(data?.byMember || [])]
    if (sortBy === 'bad') list.sort((a, b) => b.bad - a.bad || b.reviewed - a.reviewed)
    else if (sortBy === 'good') list.sort((a, b) => b.good - a.good)
    else list.sort((a, b) => b.sessions - a.sessions)
    return list
  }, [data, sortBy])

  if (!dept) return null
  const s = data?.summary
  const net = s ? s.good - s.bad : 0

  const columns = [
    { title: '客服', dataIndex: 'name', render: (v: string, r: Dashboard['byMember'][number]) => <span>{v}{!r.participate && <span className="form-hint" style={{ margin: '0 0 0 6px' }}>不参与考核</span>}</span> },
    { title: '会话', dataIndex: 'sessions', width: 100, align: 'right' as const, sorter: (a?: Agg, b?: Agg) => (a?.sessions || 0) - (b?.sessions || 0) },
    { title: '客户评价', dataIndex: 'reviewed', width: 120, align: 'right' as const, sorter: (a?: Agg, b?: Agg) => (a?.reviewed || 0) - (b?.reviewed || 0) },
    { title: '平均星级', dataIndex: 'avgStar', width: 120, align: 'right' as const, render: (v: number | null) => (v == null ? '—' : v.toFixed(2)), sorter: (a?: Agg, b?: Agg) => (a?.avgStar || 0) - (b?.avgStar || 0) },
    { title: '好评', dataIndex: 'good', width: 90, align: 'right' as const, sorter: (a?: Agg, b?: Agg) => (a?.good || 0) - (b?.good || 0) },
    { title: '差评', dataIndex: 'bad', width: 90, align: 'right' as const, render: (v: number) => (v ? <b style={{ color: '#9C3B26' }}>{v}</b> : 0), sorter: (a?: Agg, b?: Agg) => (a?.bad || 0) - (b?.bad || 0) },
    { title: 'AI 已评', dataIndex: 'aiCount', width: 110, align: 'right' as const, sorter: (a?: Agg, b?: Agg) => (a?.aiCount || 0) - (b?.aiCount || 0) },
    { title: 'AI 均分', dataIndex: 'aiAvg', width: 110, align: 'right' as const, render: (v: number | null) => (v == null ? '—' : v.toFixed(1)), sorter: (a?: Agg, b?: Agg) => (a?.aiAvg || 0) - (b?.aiAvg || 0) },
    { title: '优良率', dataIndex: 'aiGoodRate', width: 90, align: 'right' as const, render: (v: number | null) => (v == null ? '—' : `${v}%`) }
  ]

  const gradeRows = GRADES.map((g) => ({ label: g, value: data?.grades.find((x) => x.grade === g)?.count || 0 }))

  return (
    <div className="page">
      <PageHeader
        title="统计看板"
        desc={dept.groupChat ? '在线咨询的会话量、客户好评差评和 AI 质检；对公群的群问题单独统计，口径和绩效第二项一致。' : '会话量、客户好评差评和 AI 质检，按天和按客服看。'}
        scope={dept.name}
        scopeHint="按会话开始时间统计 · 好评 = 4~5 星，差评 = 1~2 星 · 北京时间"
      />

      <div className="dash-filters">
        <RadioGroup type="button" value={preset} onChange={(e) => {
          const p = e.target.value as Preset
          setPreset(p)
          if (p !== 'custom') setRange(presetRange(p))
        }}>
          <Radio value="7">近 7 天</Radio>
          <Radio value="30">近 30 天</Radio>
          <Radio value="month">本月</Radio>
          <Radio value="lastMonth">上月</Radio>
          <Radio value="custom">自定义</Radio>
        </RadioGroup>
        {preset === 'custom' && (
          <DatePicker type="dateRange" value={range} style={{ width: 260 }}
            onChange={(v) => { if (Array.isArray(v) && v[0] && v[1]) setRange([v[0] as Date, v[1] as Date]) }} />
        )}
        <Checkbox checked={onlyAssessed} onChange={(e) => setOnlyAssessed(!!e.target.checked)}>只看参与考核的客服</Checkbox>
        {loading && <Spin size="small" />}
      </div>

      {!data && !loading && <div className="notice">本部门还没有填 SaleSmartly 项目，或者还没有同步数据。</div>}
      {data && s && (
        <div className="stack" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .2s' }}>
          {data.group && <div className="panel-title" style={{ margin: '4px 0 -4px' }}>在线咨询（SaleSmartly）</div>}
          <div className="stat-row">
            <StatTile label={data.group ? '在线咨询会话' : '会话'} value={s.sessions.toLocaleString('zh-CN')} sub={`客户说过话的 ${s.spoke.toLocaleString('zh-CN')} 个`} />
            <StatTile label="客户评价" value={s.avgStar == null ? '—' : `${s.avgStar.toFixed(2)} 星`} sub={`${s.reviewed} 个会话评价，评价率 ${s.spoke ? Math.round((s.reviewed / s.spoke) * 1000) / 10 : 0}%`} />
            <StatTile label="好评" value={s.good} sub={`4~5 星，占评价 ${s.reviewed ? Math.round((s.good / s.reviewed) * 1000) / 10 : 0}%`} />
            <StatTile label="差评" value={s.bad} sub={`1~2 星；3 星中评 ${s.mid} 个`} />
            <StatTile label="净口碑" value={net > 0 ? `+${net}` : net} sub="好评数 − 差评数" />
            <StatTile label="AI 质检均分" value={s.aiAvg == null ? '—' : s.aiAvg.toFixed(1)} sub={`已评 ${s.aiCount} 个${s.aiGoodRate != null ? `，优良率 ${s.aiGoodRate}%` : ''}`} />
          </div>

          <div className="dash-grid">
            <div className="panel">
              <div className="panel-title">每日会话量</div>
              <LineChart data={data.daily.map((d) => ({ label: d.date, value: d.sessions }))} valueName="会话" formatX={md} />
              <div className="footnote">按会话开始时间分到每天。</div>
            </div>
            <div className="panel">
              <div className="panel-title">每日好评 / 差评</div>
              <Legend items={[{ color: C_GOOD, label: '好评（4~5 星）' }, { color: C_BAD, label: '差评（1~2 星）' }]} />
              <DivergingColumns data={data.daily.map((d) => ({ label: d.date, up: d.good, down: d.bad }))} upName="好评" downName="差评" formatX={md} />
              <div className="footnote">好评向上、差评向下。客户在会话结束后才评价的，下一次同步会补上。</div>
            </div>
          </div>

          <div className="dash-grid">
            <div className="panel">
              <div className="panel-head">
                <div className="panel-title" style={{ margin: 0 }}>谁的好评多，谁的差评多</div>
                <RadioGroup type="button" buttonSize="small" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                  <Radio value="bad">按差评</Radio>
                  <Radio value="good">按好评</Radio>
                  <Radio value="sessions">按会话量</Radio>
                </RadioGroup>
              </div>
              <Legend items={[{ color: C_BAD, label: '差评' }, { color: C_GOOD, label: '好评' }]} />
              <DivergingBars rows={members.map((m) => ({ key: m.sysUserId, label: m.name, left: m.bad, right: m.good, muted: !m.participate }))} leftName="差评" rightName="好评" />
              <div className="footnote">差评可以到「会话记录」里筛选满意度「差评」查看聊天记录；申诉核实后在「绩效考核」里剔除。</div>
            </div>
            <div className="panel">
              <div className="panel-title">AI 质检评级分布</div>
              {s.aiCount ? <HBars rows={gradeRows} valueName="AI 评级分布" /> : <div className="form-hint">这个时段还没有 AI 评分。到「会话记录」里批量评分后再来看。</div>}
              <div className="footnote">优秀 90 分以上、良好 75 以上、合格 60 以上、待改进 40 以上。</div>
            </div>
          </div>

          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px 8px' }} className="panel-title">按客服明细{data.group ? '（在线咨询）' : ''}</div>
            <Table rowKey="sysUserId" columns={columns} dataSource={members} pagination={false} size="middle" />
          </div>

          {data.group && <GroupSection g={data.group} />}
        </div>
      )}
    </div>
  )
}

export default DashboardPage
