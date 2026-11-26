import React, { useCallback, useEffect, useState } from 'react'
import { Button, DatePicker, Input, Modal, Radio, RadioGroup, Select, SideSheet, Spin, Table, TextArea, Toast, Tooltip } from '@douyinfe/semi-ui'
import { IconSearch } from '@douyinfe/semi-icons'
import { api } from '../api'
import { useAuth } from '../auth'
import PageHeader from '../components/PageHeader'
import { fmtTime } from '../utils'
import { scoreColor } from '../constants'

interface Review { boundaryOk: number | null; handlerOk: number | null; statusOk: number | null; note: string; by: string }
interface Issue {
  id: number; day: string; roomName: string; summary: string; messageCount: number
  handlerUserId: string; handlerName: string; handlerMember: string; counted: boolean; handlerReason: string; aiHandlerName: string
  status: string; aiStatus: string; overridden: boolean; evidence: string; difficulty: number; syncGapSec: number | null
  firstCustomerAt: number; firstReplySec: number | null; resolveSec: number | null; review: Review | null
}
interface Person { name: string; sysUserId: number; issues: number; weighted: number; resolved: number; unresolved: number; handed: number; unknown: number; closureRate: number | null; avgFirstSec: number | null; avgResolveSec: number | null; ruleSessions: number }
interface ListResp {
  total: number; list: Issue[]; counts: { all: number; others: number; nobody: number }; summary: Person[]
  accuracy: { reviewed: number; allOk: number; boundaryOk: number; handlerOk: number; statusOk: number }
  analysis: { progress: { rooms: number; roomsDone: number; calls: number; failed: number } | null; ok: number; failed: number; tokens: number; lastAt: number; failures: Array<{ room_id: string; day: string; error: string }> }
  handlers: Array<{ sysUserId: number; name: string }>
  /** 技术支持部第二项现在按什么算：ai = 群问题，rule = 规则群会话 */
  kpiSource: 'ai' | 'rule'
}
interface Detail {
  issue: Issue & { helpers: string[]; resolvedMsgId: string; avgReplySec: number | null; score: number | null; scoreParts: Record<string, number | null> | null }
  messages: Array<{ id: string; senderType: string; senderName: string; content: string; sendTime: number; isResolved: boolean }>
  handlerOptions: Array<{ userId: string; name: string; counted: boolean }>
}

const STATUS_TEXT: Record<string, string> = { resolved: '已解决', unresolved: '未解决', unknown: '判断不了', handed: '交接完整', handed_part: '交接不完整' }
const STATUS_CLASS: Record<string, string> = { resolved: 'success', unresolved: 'danger', unknown: 'muted', handed: 'muted', handed_part: 'muted' }
/** 改状态的选项（交接两项只能主管标） */
const STATUS_OPTIONS = [
  { value: 'resolved', label: '已解决（闭环 1）' }, { value: 'handed', label: '没解决·交接完整（0.8）' },
  { value: 'handed_part', label: '没解决·交接不完整（0.4）' }, { value: 'unresolved', label: '未解决·没交接（0）' }, { value: 'unknown', label: '判断不了（不算）' }
]
const DIFFICULTY_TEXT: Record<number, string> = { 1: '简单', 2: '一般', 3: '疑难' }
const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const sec = (s: number | null): string => (s == null ? '—' : s < 60 ? `${s}秒` : s < 3600 ? `${Math.round(s / 60)}分钟` : `${Math.floor(s / 3600)}小时${Math.round((s % 3600) / 60)}分`)
const hms = (t: number): string => fmtTime(t).slice(5)

export const StatusPill: React.FC<{ s: string; overridden?: boolean }> = ({ s, overridden }) => (
  <span className={`pill-tag ${STATUS_CLASS[s] || 'muted'}`}>{STATUS_TEXT[s] || s}{overridden ? ' · 改过' : ''}</span>
)

const PART_NAMES: Record<string, string> = { firstResp: '首次响应', avgResp: '平均响应', timeliness: '处理时效', closure: '是否解决' }
/** 单题分的组成：第二项里能按单个问题算的几项，各自得该项分值的百分之几 */
export const ScoreParts: React.FC<{ parts: Record<string, number | null> | null | undefined }> = ({ parts }) => (
  <div style={{ lineHeight: 1.8 }}>
    <div>单题分 = 下面几项按「考核规则 → 第二项」的分值加权平均</div>
    {Object.entries(parts || {}).map(([k, v]) => <div key={k}>{PART_NAMES[k] || k}：{v == null ? '不算' : `${Math.round(v)}%`}</div>)}
    <div style={{ opacity: 0.75 }}>人的第二项还要看解决问题数、闭环率、满意度和扣分</div>
  </div>
)

/** 三项核对：对 / 不对 / 没核对 */
const Judge: React.FC<{ label: string; value: number | null; onChange: (v: number | null) => void }> = ({ label, value, onChange }) => (
  <div className="judge-row">
    <span>{label}</span>
    <RadioGroup type="button" buttonSize="small" value={value === null ? 'x' : String(value)} onChange={(e) => onChange(e.target.value === 'x' ? null : Number(e.target.value))}>
      <Radio value="1">对</Radio>
      <Radio value="0">不对</Radio>
      <Radio value="x">没核对</Radio>
    </RadioGroup>
  </div>
)

export const IssueDrawer: React.FC<{ deptCode: string; id: number | null; onClose: () => void; onChanged: () => void }> = ({ deptCode, id, onClose, onChanged }) => {
  const [d, setD] = useState<Detail | null>(null)
  const [rv, setRv] = useState<{ boundaryOk: number | null; handlerOk: number | null; statusOk: number | null; note: string }>({ boundaryOk: null, handlerOk: null, statusOk: null, note: '' })
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    if (!id) return
    api<Detail>(`/api/issues/${id}`, { query: { dept: deptCode } })
      .then((x) => {
        setD(x)
        const r = x.issue.review
        setRv({ boundaryOk: r?.boundaryOk ?? null, handlerOk: r?.handlerOk ?? null, statusOk: r?.statusOk ?? null, note: r?.note || '' })
      })
      .catch((e) => Toast.error((e as Error).message))
  }, [id, deptCode])
  useEffect(() => { setD(null); load() }, [load])

  const saveReview = async (): Promise<void> => {
    if (!id) return
    setSaving(true)
    try {
      await api(`/api/issues/${id}/review`, { method: 'PUT', body: rv, query: { dept: deptCode } })
      Toast.success('核对结果已保存')
      onChanged()
    } catch (e) {
      Toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const override = async (body: Record<string, unknown>): Promise<void> => {
    if (!id) return
    try {
      await api(`/api/issues/${id}/override`, { method: 'PUT', body, query: { dept: deptCode } })
      Toast.success('已修改')
      load()
      onChanged()
    } catch (e) {
      Toast.error((e as Error).message)
    }
  }

  const i = d?.issue
  return (
    <SideSheet title={i ? `${i.day} · ${i.roomName}` : ''} visible={!!id} onCancel={onClose} width={680} bodyStyle={{ padding: 0 }}>
      {!d || !i ? <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div> : (
        <>
          <div className="score-card">
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--app-blue)' }}>{i.summary}</div>
            <div className="detail-grid" style={{ padding: 0, border: 'none' }}>
              <div><span>处理人</span><b>{i.handlerName || '没人处理'}{i.handlerName && !i.counted && <em>（不计入）</em>}</b></div>
              <div><span>状态</span><b><StatusPill s={i.status} overridden={i.overridden} /></b></div>
              <div><span>首响</span><b>{sec(i.firstReplySec)}</b></div>
              <div><span>平均响应</span><b>{sec(i.avgReplySec)}</b></div>
              <div>
                <span>处理时效</span>
                <b>{sec(i.resolveSec)}{i.resolveSec != null && i.resolveSec > 3600 && <em>（期间最长 {sec(i.syncGapSec)} 没同步进度）</em>}</b>
              </div>
              <div>
                <span>单题分</span>
                <Tooltip content={<ScoreParts parts={i.scoreParts} />}>
                  <b style={{ color: i.score == null ? undefined : scoreColor(i.score) }}>{i.score == null ? '—' : i.score}</b>
                </Tooltip>
              </div>
              {i.helpers.length > 0 && <div style={{ gridColumn: '1 / -1' }}><span>协助</span><b>{i.helpers.join('、')}</b></div>}
              <div style={{ gridColumn: '1 / -1' }}><span>归属理由</span><b style={{ fontWeight: 400 }}>{i.handlerReason || '—'}</b></div>
              {i.evidence && <div style={{ gridColumn: '1 / -1' }}><span>依据原话</span><b style={{ fontWeight: 400 }}>「{i.evidence}」</b></div>}
              {i.overridden && <div style={{ gridColumn: '1 / -1' }}><span>AI 原判</span><b style={{ fontWeight: 400 }}>{i.aiHandlerName || '没人处理'} · {STATUS_TEXT[i.aiStatus]}</b></div>}
            </div>
            <div className="issue-edit">
              <span className="form-label">改处理人</span>
              <Select size="small" style={{ width: 220 }} value={i.handlerUserId || ''} filter
                optionList={[{ value: '', label: '没人处理' }, ...d.handlerOptions.map((o) => ({ value: o.userId, label: o.counted ? o.name : `${o.name}（不计入）` }))]}
                onChange={(v) => void override({ handlerUserId: String(v ?? '') })} />
              <span className="form-label">改状态</span>
              <Select size="small" style={{ width: 200 }} value={i.status} optionList={STATUS_OPTIONS}
                onChange={(v) => void override({ status: String(v) })} />
              <span className="form-label">难度</span>
              <Select size="small" style={{ width: 90 }} value={i.difficulty || 1} optionList={[1, 2, 3].map((v) => ({ value: v, label: DIFFICULTY_TEXT[v] }))}
                onChange={(v) => void override({ difficulty: Number(v) === 1 ? null : Number(v) })} />
              {i.overridden && <Button size="small" theme="borderless" onClick={() => void override({ handlerUserId: null, status: null })}>恢复 AI 的判断</Button>}
            </div>
          </div>
          <div className="score-card">
            <div className="panel-title" style={{ margin: 0, fontSize: 14 }}>核对（算准确率用，三项都填才算核对过）</div>
            <Judge label="问题边界（消息分得对不对）" value={rv.boundaryOk} onChange={(v) => setRv({ ...rv, boundaryOk: v })} />
            <Judge label="处理人" value={rv.handlerOk} onChange={(v) => setRv({ ...rv, handlerOk: v })} />
            <Judge label="是否解决" value={rv.statusOk} onChange={(v) => setRv({ ...rv, statusOk: v })} />
            <TextArea value={rv.note} onChange={(v) => setRv({ ...rv, note: v })} placeholder="哪里不对（可选）" autosize={{ minRows: 1, maxRows: 4 }} />
            <div><Button theme="solid" size="small" loading={saving} onClick={() => void saveReview()}>保存核对</Button>
              {i.review?.by && <span className="form-hint" style={{ marginLeft: 10 }}>上次核对：{i.review.by}</span>}</div>
          </div>
          <div className="chat-container" style={{ height: 'auto', overflow: 'visible' }}>
            {d.messages.map((m) => {
              const cls = m.senderType === 'staff' ? 'staff' : m.senderType === 'bot' ? 'bot' : 'customer'
              return (
                <div key={m.id} className={`chat-bubble ${cls}`}>
                  <div className={`bubble-avatar ${cls}`}>{cls === 'customer' ? '客' : cls === 'bot' ? '机' : (m.senderName || '员').replace(/^.*[-－—]/, '').charAt(0)}</div>
                  <div className="bubble-body">
                    <div className="bubble-name-time" style={{ textAlign: cls === 'staff' ? 'right' : 'left' }}>{m.senderName} · {hms(m.sendTime)}{m.isResolved ? ' · ✓ 解决' : ''}</div>
                    <div className={`bubble-text ${cls}`} style={m.isResolved ? { outline: '2px solid #2F855A', outlineOffset: 2 } : undefined}>{m.content}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </SideSheet>
  )
}

const IssuesPage: React.FC = () => {
  const { dept } = useAuth()
  const t = new Date()
  const [range, setRange] = useState<[Date, Date]>([new Date(t.getFullYear(), t.getMonth(), 1), t])
  const [handler, setHandler] = useState('')
  const [status, setStatus] = useState('')
  const [review, setReview] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ListResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  const [reOpen, setReOpen] = useState(false)
  const [reRange, setReRange] = useState<[Date, Date] | null>(null)
  const [force, setForce] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!dept) return
    setLoading(true)
    try {
      setData(await api<ListResp>('/api/issues', { query: { dept: dept.code, from: ymd(range[0]), to: ymd(range[1]), handler, status, review, keyword, page } }))
    } catch (e) {
      Toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [dept, range, handler, status, review, keyword, page])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!data?.analysis.progress) return
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [data?.analysis.progress, load])

  if (!dept) return null
  const acc = data?.accuracy
  const pct = acc && acc.reviewed ? Math.round((acc.allOk / acc.reviewed) * 100) : null
  const reset = <T,>(f: (v: T) => void) => (v: T): void => { f(v); setPage(1) }

  const reanalyze = async (): Promise<void> => {
    if (!reRange) return void Toast.warning('先选日期')
    try {
      await api('/api/issues/analyze', { body: { from: ymd(reRange[0]), to: ymd(reRange[1]), force }, query: { dept: dept.code } })
      setReOpen(false)
      Toast.success('已开始分析，在后台跑')
      void load()
    } catch (e) {
      Toast.error((e as Error).message)
    }
  }

  const columns = [
    {
      title: '日期', dataIndex: 'day', width: 100,
      render: (v: string, r: Issue) => (
        <div>{v.slice(5)}<div className="kpi-cell-sub">{r.firstCustomerAt ? hms(r.firstCustomerAt).slice(6) : ''}</div>
          {v === ymd(new Date()) && <Tooltip content="今天的聊天还在继续，群里有新消息时 AI 会重新整理，这个问题可能会变。核对建议看前一天及以前的。"><span className="pill-tag muted" style={{ marginTop: 2 }}>还可能变</span></Tooltip>}
        </div>
      )
    },
    { title: '问题', dataIndex: 'summary', render: (v: string, r: Issue) => <div><div style={{ fontWeight: 500 }}>{v}</div><div className="kpi-cell-sub">{r.roomName} · {r.messageCount} 条消息</div></div> },
    {
      title: '处理人', dataIndex: 'handlerName', width: 150,
      render: (v: string, r: Issue) => v ? <span><span className={`pill-tag ${r.counted ? '' : 'muted'}`}>{v.replace(/^.*[-－—]/, '')}</span>{!r.counted && <div className="kpi-cell-sub">不计入</div>}</span> : <span className="form-hint" style={{ margin: 0 }}>没人处理</span>
    },
    { title: '状态', dataIndex: 'status', width: 110, render: (v: string, r: Issue) => <StatusPill s={v} overridden={r.overridden} /> },
    { title: '首响', dataIndex: 'firstReplySec', width: 90, render: (v: number | null) => sec(v) },
    { title: '处理时效', dataIndex: 'resolveSec', width: 100, render: (v: number | null) => sec(v) },
    {
      title: '核对', key: 'review', width: 100,
      render: (_: unknown, r: Issue) => {
        const x = r.review
        if (!x || x.boundaryOk === null || x.handlerOk === null || x.statusOk === null) return <span className="form-hint" style={{ margin: 0 }}>{x ? '没核对完' : '—'}</span>
        const ok = x.boundaryOk === 1 && x.handlerOk === 1 && x.statusOk === 1
        return <Tooltip content={x.note || (ok ? '三项都对' : '有不对的')}><span className={`pill-tag ${ok ? 'success' : 'danger'}`}>{ok ? '全对' : '有错'}</span></Tooltip>
      }
    }
  ]

  const personCols = [
    { title: '处理人', dataIndex: 'name' },
    { title: 'AI 识别的问题', dataIndex: 'issues', width: 120, render: (v: number, p: Person) => (p.weighted !== v ? <span>{v}<span className="kpi-cell-sub">（加权 {p.weighted}）</span></span> : v) },
    { title: data?.kpiSource === 'rule' ? '规则群会话（现在计分用的）' : '规则群会话（对照）', dataIndex: 'ruleSessions', width: 170 },
    { title: '已解决', dataIndex: 'resolved', width: 80 },
    { title: '未解决', dataIndex: 'unresolved', width: 80 },
    { title: '交接', dataIndex: 'handed', width: 70 },
    { title: '判断不了', dataIndex: 'unknown', width: 90 },
    { title: '闭环率', dataIndex: 'closureRate', width: 90, render: (v: number | null) => (v == null ? '—' : `${v}%`) },
    { title: '平均首响', dataIndex: 'avgFirstSec', width: 100, render: (v: number | null) => sec(v) },
    { title: '平均处理时效', dataIndex: 'avgResolveSec', width: 120, render: (v: number | null) => sec(v) }
  ]

  return (
    <div className="page">
      <PageHeader
        title="群问题"
        desc="AI 把对公群的聊天按「客户问题」整理出来：谁实际处理的、解决没有、依据哪句原话。首响、处理时效由程序按消息时间算。"
        scope={dept.name}
        scopeHint={`${data?.kpiSource === 'rule' ? '第二项现在按规则群会话计分' : '计入技术支持部第二项'} · 每 10 分钟同步群消息，一个群聊天停下 30 分钟就自动分析（当天也分析）`}
        extra={
          <>
            {data?.analysis.progress
              ? <span className="pill-tag">正在分析 {data.analysis.progress.roomsDone}/{data.analysis.progress.rooms} 个群</span>
              : <span className="pill-tag">{data?.analysis.lastAt ? '已分析' : '未分析'}</span>}
            <div>
              <div>最近分析 {data?.analysis.lastAt ? fmtTime(data.analysis.lastAt) : '—'}</div>
              <div>{data ? `${data.analysis.ok} 个群·天${data.analysis.failed ? `，失败 ${data.analysis.failed}` : ''}，约 ${(data.analysis.tokens / 10000).toFixed(1)} 万 tokens` : ''}</div>
            </div>
            <Button onClick={() => setReOpen(true)} disabled={!!data?.analysis.progress}>重新分析</Button>
          </>
        }
      />

      <div className={`notice ${pct !== null && pct >= 90 && (acc?.reviewed || 0) >= 30 ? 'success' : ''}`} style={{ marginTop: 0 }}>
        <b>核对进度</b>：已核对 {acc?.reviewed || 0} 个问题{pct !== null ? `，三项全对 ${acc?.allOk} 个，准确率 ${pct}%（边界 ${acc?.boundaryOk}、处理人 ${acc?.handlerOk}、是否解决 ${acc?.statusOk} 个对）` : ''}。
        {data?.kpiSource === 'rule'
          ? '技术支持部第二项现在按规则群会话计分（设置 → 考核规则里可以改成按群问题）。'
          : '技术支持部第二项按这里的群问题计分（处理人、状态按主管改过的算；设置 → 考核规则里可以切回规则群会话）。AI 会出错，建议主管每周抽查。'}
        点问题打开，看聊天记录，三项各点「对 / 不对」，判断错的直接改处理人或状态；今天的问题还可能变，建议核对前一天及以前的。
      </div>

      <div className="panel filter-panel">
        <div className="filter-item">
          <span className="form-label">问题开始日期</span>
          <DatePicker type="dateRange" value={range} style={{ width: 260 }} onChange={(v) => { if (Array.isArray(v) && v[0] && v[1]) { setRange([v[0] as Date, v[1] as Date]); setPage(1) } }} />
        </div>
        <div className="filter-item">
          <span className="form-label">处理人</span>
          <Select value={handler} style={{ width: 160 }} onChange={(v) => reset(setHandler)(String(v ?? ''))}
            optionList={[{ value: '', label: '全部' }, ...(data?.handlers || []).map((h) => ({ value: String(h.sysUserId), label: h.name })), { value: 'others', label: '不计入的人（商务等）' }, { value: 'none', label: '没人处理' }]} />
        </div>
        <div className="filter-item">
          <span className="form-label">状态</span>
          <Select value={status} style={{ width: 120 }} onChange={(v) => reset(setStatus)(String(v ?? ''))} optionList={[{ value: '', label: '全部' }, ...Object.entries(STATUS_TEXT).map(([value, label]) => ({ value, label }))]} />
        </div>
        <div className="filter-item">
          <span className="form-label">核对</span>
          <Select value={review} style={{ width: 120 }} onChange={(v) => reset(setReview)(String(v ?? ''))} optionList={[{ value: '', label: '全部' }, { value: 'unreviewed', label: '没核对' }, { value: 'reviewed', label: '核对过' }, { value: 'wrong', label: '有错的' }]} />
        </div>
        <div className="filter-item" style={{ flex: 1, minWidth: 200 }}>
          <span className="form-label">关键词</span>
          <Input prefix={<IconSearch />} value={keyword} onChange={reset(setKeyword)} placeholder="摘要、群名、原话" showClear />
        </div>
      </div>

      {data && (
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px 4px' }} className="panel-title">每人汇总</div>
          <div className="footnote" style={{ padding: '0 24px 8px' }}>
            共 {data.counts.all} 个问题；另有 {data.counts.others} 个是商务、客服等不计入的人处理的，{data.counts.nobody} 个没人处理。
            闭环率 = 各问题计分之和 ÷ 问题数（解决 1、交接完整 0.8、交接不完整 0.4、没解决 0；判断不了的确认前不算）。和「规则群会话」差得多的人，优先抽他的问题核对。
          </div>
          <Table rowKey="sysUserId" size="middle" columns={personCols} dataSource={data.summary} pagination={false} />
        </div>
      )}

      <div className="panel" style={{ padding: 0, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
        <Table rowKey="id" columns={columns} dataSource={data?.list || []} loading={!data}
          onRow={(r?: Issue) => ({ onClick: () => r && setOpenId(r.id), style: { cursor: 'pointer' } })}
          empty={data?.analysis.ok ? '这个条件下没有问题' : '还没有分析结果。群消息每 10 分钟同步，聊完的群会自动分析，也可以点右上角「重新分析」。'}
          pagination={{ currentPage: page, pageSize: 20, total: data?.total || 0, onPageChange: setPage, style: { padding: '12px 20px' } }} />
      </div>

      {!!data?.analysis.failures.length && (
        <div className="footnote">分析失败的群·天（下次同步会自动重试，同样的输入失败 3 次后不再自动试）：{data.analysis.failures.map((f) => `${f.day} ${f.error.slice(0, 40)}`).join('；')}</div>
      )}

      <IssueDrawer deptCode={dept.code} id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />
      <Modal title="重新分析" visible={reOpen} onCancel={() => setReOpen(false)} onOk={() => void reanalyze()} okText="开始">
        <div className="stack" style={{ gap: 12, paddingBottom: 8 }}>
          <div className="notice" style={{ marginTop: 0 }}>平时每 10 分钟同步一次群消息，聊完的群自动分析，没有新消息的直接用上次结果，不重复花钱。改了员工挂靠、群筛选后可以在这里重跑。</div>
          <DatePicker type="dateRange" value={reRange ?? undefined} style={{ width: 280 }} disabledDate={(d) => !!d && d.getTime() > Date.now()}
            onChange={(v) => setReRange(Array.isArray(v) && v[0] && v[1] ? [v[0] as Date, v[1] as Date] : null)} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            不用缓存，全部重新调 AI（会花钱，一般不用勾；主管改过的处理人 / 状态和核对结果不会丢）
          </label>
        </div>
      </Modal>
    </div>
  )
}

export default IssuesPage
