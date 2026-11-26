import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, DatePicker, Input, Select, Spin, Table, Toast, Tooltip } from '@douyinfe/semi-ui'
import { IconSearch } from '@douyinfe/semi-icons'
import { api } from '../api'
import { useAuth } from '../auth'
import PageHeader from '../components/PageHeader'
import SessionDrawer, { GradePill, Stars, type AIScore } from '../components/SessionDrawer'
import SyncModal, { SyncProgressLine, useSyncStatus } from '../components/SyncModal'
import BatchScoreModal, { BatchProgress, useBatchJob } from '../components/BatchScore'
import { IssueDrawer, ScoreParts, StatusPill } from './IssuesPage'
import { channelName, fmtDuration, GRADES, scoreColor } from '../constants'
import { copyText, fmtTime } from '../utils'

export interface SessionItem {
  sessionId: string
  source?: 'ss' | 'wg'
  chatUserId: string
  customerName: string
  sysUserId: number
  memberName: string
  participate: boolean
  channel: number
  startTime: number
  endTime: number
  starScore: number
  msgCount: number
  customerMsgCount: number
  staffMsgCount: number
  scoreStatus: 'none' | 'ok' | 'failed'
  aiTotal: number | null
  aiGrade: string
  aiReviewed: boolean
  /** 对公群（source = 'wg'）：AI 整理的群问题 */
  issueId?: number
  issueStatus?: string
  issueSummary?: string
  /** 单题分（技术支持部第二项规则）和组成 */
  issueScore?: number | null
  issueParts?: Record<string, number | null>
}

interface ListResp {
  list: SessionItem[]
  total: number
  summary: { reviewed: number; bad: number; avgStar: number; aiScored: number; aiAvg: number }
}

interface Filters {
  members: Array<{ sysUserId: number; nickname: string; participate: boolean }>
  channels: number[]
}

const startOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000)
const endOfDay = (d: Date): number => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime() / 1000)
const ymd = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()}`

const STAR_OPTIONS = [
  { value: '', label: '全部满意度' },
  { value: 'reviewed', label: '已评价' },
  { value: 'unreviewed', label: '未评价' },
  { value: 'good', label: '好评（4~5 星）' },
  { value: 'bad', label: '差评（1~2 星）' },
  ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} 星` }))
]

const AI_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'scored', label: '已评分' },
  { value: 'unscored', label: '未评分' },
  { value: 'failed', label: '评分失败' },
  ...GRADES.map((g) => ({ value: `grade:${g}`, label: g }))
]

/** embedded：嵌在别的页面里（对公群页），不显示页头；fixedSource：固定只看某个来源 */
const SessionsPage: React.FC<{ embedded?: boolean; fixedSource?: 'ss' | 'wg' }> = ({ embedded, fixedSource }) => {
  const { dept } = useAuth()
  const [source, setSource] = useState<'' | 'ss' | 'wg'>(fixedSource || '')
  const today = new Date()
  const [range, setRange] = useState<[Date, Date]>([new Date(today.getFullYear(), today.getMonth(), 1), today])
  const [member, setMember] = useState<number | ''>('')
  const [channel, setChannel] = useState<number | ''>('')
  const [star, setStar] = useState('')
  const [aiFilter, setAiFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [kwApplied, setKwApplied] = useState('')
  // 默认只看参与考核的人（和桌面版一致：桌面版连不参与考核的人的会话都不同步）
  const [onlyAssessed, setOnlyAssessed] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [data, setData] = useState<ListResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState<Filters>({ members: [], channels: [] })
  const [detail, setDetail] = useState<SessionItem | null>(null)
  const [issueId, setIssueId] = useState<number | null>(null)
  /** 点行：在线咨询看聊天记录和评分；对公群看 AI 整理的问题和聊天记录 */
  const open = useCallback((r: SessionItem) => { if (r.source === 'wg') setIssueId(r.issueId || null); else setDetail(r) }, [])
  const [syncOpen, setSyncOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [scoringIds, setScoringIds] = useState<Set<string>>(new Set())

  /** 当前筛选条件（列表查询和批量评分共用） */
  const filter = useMemo(() => ({
    begin: startOfDay(range[0]),
    end: endOfDay(range[1]),
    member, channel, star,
    keyword: kwApplied,
    participate: onlyAssessed ? 1 : '',
    score: aiFilter.startsWith('grade:') ? '' : aiFilter,
    grade: aiFilter.startsWith('grade:') ? aiFilter.slice(6) : '',
    source
  }), [range, member, channel, star, kwApplied, onlyAssessed, aiFilter, source])

  const load = useCallback(async (): Promise<void> => {
    if (!dept) return
    setLoading(true)
    try {
      setData(await api<ListResp>('/api/sessions', { query: { dept: dept.code, page, pageSize, ...filter } }))
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [dept, page, pageSize, filter])

  useEffect(() => { void load() }, [load])

  const loadFilters = useCallback(() => {
    if (!dept) return
    api<Filters>('/api/sessions/filters', { query: { dept: dept.code } }).then(setFilters).catch(() => { /* 筛选项拉不到不影响列表 */ })
  }, [dept])
  useEffect(loadFilters, [loadFilters])

  // 同步跑完自动刷新列表和筛选项
  const { status, reload: reloadStatus } = useSyncStatus(dept?.code, () => { void load(); loadFilters() })
  // 批量评分跑完刷新列表
  const { job, reload: reloadJob } = useBatchJob(dept?.code, (j) => {
    void load()
    if (j.abortReason) Toast.error({ content: `批量评分已自动停止：${j.abortReason}`, duration: 8 })
    else if (j.cancelled) Toast.info(`批量评分已取消：评完 ${j.ok} 个${j.failed ? `，失败 ${j.failed} 个` : ''}`)
    else if (j.failed) Toast.warning(`批量评分结束：成功 ${j.ok} 个，失败 ${j.failed} 个（再点一次批量评分会重试失败的）`)
    else Toast.success(`批量评分完成，共评 ${j.ok} 个`)
  })

  // 关键词停止输入 400ms 后再查
  useEffect(() => {
    const t = setTimeout(() => { setKwApplied(keyword.trim()); setPage(1) }, 400)
    return () => clearTimeout(t)
  }, [keyword])

  const resetPage = <T,>(set: (v: T) => void) => (v: T): void => { set(v); setPage(1) }

  const copy = async (text: string): Promise<void> => {
    if (!text) return
    if (await copyText(text)) Toast.success({ content: `已复制：${text}`, duration: 1.5 })
    else Toast.error('复制失败')
  }

  /** 评分结果回写到列表（详情里评分 / 复核、行内评分都走这里） */
  const applyScore = useCallback((sessionId: string, s: AIScore | null) => {
    setData((prev) => prev && {
      ...prev,
      list: prev.list.map((r) => r.sessionId !== sessionId ? r : {
        ...r,
        scoreStatus: s ? s.status : 'none',
        aiTotal: s?.status === 'ok' ? s.total : r.aiTotal,
        aiGrade: s?.status === 'ok' ? s.grade : r.aiGrade,
        aiReviewed: !!s?.reviewed
      })
    })
  }, [])

  const scoreRow = useCallback(async (r: SessionItem): Promise<void> => {
    if (!dept) return
    setScoringIds((prev) => new Set(prev).add(r.sessionId))
    try {
      const s = await api<AIScore>(`/api/sessions/${encodeURIComponent(r.sessionId)}/score`, { body: {}, query: { dept: dept.code } })
      applyScore(r.sessionId, s)
    } catch (err) {
      Toast.error((err as Error).message)
      setData((prev) => prev && { ...prev, list: prev.list.map((x) => (x.sessionId === r.sessionId && x.scoreStatus !== 'ok' ? { ...x, scoreStatus: 'failed' } : x)) })
    } finally {
      setScoringIds((prev) => { const n = new Set(prev); n.delete(r.sessionId); return n })
    }
  }, [dept, applyScore])

  const columns = useMemo(() => [
    {
      title: '客户', dataIndex: 'customerName', width: 360,
      render: (v: string, r: SessionItem) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="avatar-dot">{(v || '?').charAt(0)}</span>
          <span
            className="copyable-name"
            title="点击复制"
            style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            onClick={(e) => { e.stopPropagation(); void copy(v) }}
          >
            {v || '—'}
          </span>
          {r.source === 'wg' && r.issueSummary && <div className="kpi-cell-sub" style={{ whiteSpace: 'normal' }}>{r.issueSummary}</div>}
        </div>
      )
    },
    {
      title: '接待客服', dataIndex: 'memberName', width: 130,
      render: (v: string, r: SessionItem) => (
        <span>
          <span className="pill-tag">{v || '—'}</span>
          {!r.participate && <div className="form-hint" style={{ margin: '2px 0 0' }}>不参与考核</div>}
        </span>
      )
    },
    {
      title: '渠道', dataIndex: 'channel', width: 110,
      render: (v: number, r: SessionItem) => r.source === 'wg'
        ? <Tooltip content="对公群里的一个客户问题：AI 把群聊按问题整理好，看谁实际处理的、解决没有（群聊停下 30 分钟后整理，今天的还可能变）。分数是单题分，按第二项规则算，计入技术支持部绩效第二项。"><span><span className="pill-tag muted">企微群</span><div className="kpi-cell-sub">AI 整理</div></span></Tooltip>
        : <span className="pill-tag muted">{channelName(v)}</span>
    },
    {
      title: '会话时间', dataIndex: 'startTime', width: 130,
      render: (t: number, r: SessionItem) => (
        <div>
          <div>{fmtTime(t).slice(5)}</div>
          {r.endTime > 0 && <div className="form-hint" style={{ margin: 0 }}>时长 {fmtDuration(r.endTime - t)}</div>}
        </div>
      )
    },
    { title: '满意度', dataIndex: 'starScore', width: 120, render: (v: number, r: SessionItem) => (r.source === 'wg' ? <span className="form-hint" style={{ margin: 0 }}>群聊无评价</span> : <Stars v={v} />) },
    {
      title: 'AI 质检', key: 'ai', width: 150,
      render: (_: unknown, r: SessionItem) => {
        if (r.source === 'wg') {
          return (
            <Tooltip content={<ScoreParts parts={r.issueParts} />}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {r.issueScore != null && <b style={{ color: scoreColor(r.issueScore), fontSize: 15 }}>{r.issueScore.toFixed(1)}</b>}
                <StatusPill s={r.issueStatus || 'unknown'} />
              </span>
            </Tooltip>
          )
        }
        if (scoringIds.has(r.sessionId)) return <span className="form-hint" style={{ margin: 0 }}><Spin size="small" /> 评分中</span>
        if (r.scoreStatus === 'ok' && r.aiTotal != null) {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <b style={{ color: scoreColor(r.aiTotal), fontSize: 15 }}>{r.aiTotal.toFixed(1)}</b>
              <GradePill grade={r.aiGrade} reviewed={r.aiReviewed} />
            </span>
          )
        }
        if (r.scoreStatus === 'failed') return <span className="pill-tag danger">评分失败</span>
        return <span className="form-hint" style={{ margin: 0 }}>{r.customerMsgCount ? '未评分' : '客户没说话'}</span>
      }
    },
    {
      title: '', key: 'op', align: 'right' as const,
      render: (_: unknown, r: SessionItem) => (
        <span style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <Button size="small" theme="borderless" onClick={() => open(r)}>查看</Button>
          {r.source !== 'wg' && r.customerMsgCount > 0 && (
            <Tooltip content={r.scoreStatus === 'ok' ? '重新评分' : 'AI 评分'}>
              <Button size="small" theme="borderless" disabled={scoringIds.has(r.sessionId)} onClick={() => void scoreRow(r)}>
                {r.scoreStatus === 'ok' ? '重评' : '评分'}
              </Button>
            </Tooltip>
          )}
        </span>
      )
    }
  ], [scoringIds, scoreRow, open])

  if (!dept) return null
  const last = status?.lastSuccess
  const noProject = status && !status.projectId
  const jobRunning = !!job && !job.finishedAt

  return (
    <div className={embedded ? 'stack' : 'page'}>
      {!embedded && <PageHeader
        title="会话记录"
        desc={dept.groupChat ? '在线咨询（SaleSmartly）的会话和 AI 质检评分；对公群按 AI 整理出的客户问题列出，挂在处理人名下。' : '查看 SaleSmartly 会话、聊天记录和 AI 质检评分，按客服、时间、满意度筛选。'}
        scope={dept.name}
        scopeHint="只显示本部门客服接待的会话 · 按会话开始时间筛选 · 北京时间"
        extra={
          <>
            {status?.progress
              ? <SyncProgressLine p={status.progress} />
              : <span className="pill-tag">{last ? '已同步' : '未同步'}</span>}
            <div>
              {!status?.progress && <div>最近同步 {last ? fmtTime(last.finishedAt) : '—'}</div>}
              <div>每 {status?.autoIntervalMin ?? 60} 分钟自动同步</div>
            </div>
            <Button onClick={() => { reloadStatus(); setSyncOpen(true) }}>同步数据</Button>
          </>
        }
      />}

      {noProject && <div className="notice">本部门还没有填 SaleSmartly 项目，先到「设置 → 数据源与 AI」里填好。</div>}

      <div className="panel filter-panel">
        <div className="filter-item">
          <span className="form-label">会话日期</span>
          <DatePicker
            type="dateRange"
            value={range}
            onChange={(v) => { if (Array.isArray(v) && v.length === 2 && v[0] && v[1]) { setRange([v[0] as Date, v[1] as Date]); setPage(1) } }}
            style={{ width: 260 }}
          />
        </div>
        <div className="filter-item">
          <span className="form-label">接待客服</span>
          <Select
            filter
            showClear
            placeholder="全部客服（可输入搜索）"
            value={member === '' ? undefined : member}
            onChange={(v) => resetPage(setMember)(v === undefined ? '' : Number(v))}
            optionList={filters.members.map((m) => ({ value: m.sysUserId, label: m.participate ? m.nickname : `${m.nickname}（不参与考核）` }))}
            style={{ width: 200 }}
          />
        </div>
        {dept.groupChat && !fixedSource && (
          <div className="filter-item">
            <span className="form-label">来源</span>
            <Select value={source} onChange={(v) => resetPage(setSource)((v || '') as '' | 'ss' | 'wg')} style={{ width: 130 }}
              optionList={[{ value: '', label: '全部' }, { value: 'ss', label: '在线咨询' }, { value: 'wg', label: '对公群' }]} />
          </div>
        )}
        <div className="filter-item">
          <span className="form-label">渠道</span>
          <Select
            showClear
            placeholder="全部渠道"
            value={channel === '' ? undefined : channel}
            onChange={(v) => resetPage(setChannel)(v === undefined ? '' : Number(v))}
            optionList={filters.channels.map((c) => ({ value: c, label: channelName(c) }))}
            style={{ width: 130 }}
          />
        </div>
        <div className="filter-item">
          <span className="form-label">满意度</span>
          <Select value={star} onChange={(v) => resetPage(setStar)(String(v ?? ''))} optionList={STAR_OPTIONS} style={{ width: 150 }} />
        </div>
        <div className="filter-item">
          <span className="form-label">AI 质检</span>
          <Select value={aiFilter} onChange={(v) => resetPage(setAiFilter)(String(v ?? ''))} optionList={AI_OPTIONS} style={{ width: 120 }} />
        </div>
        <div className="filter-item" style={{ flex: 1, minWidth: 200 }}>
          <span className="form-label">关键词</span>
          <Input prefix={<IconSearch />} placeholder="客户名、会话 ID、访客 ID" value={keyword} onChange={setKeyword} showClear />
        </div>
        <div className="filter-item" style={{ justifyContent: 'flex-end' }}>
          <Checkbox checked={onlyAssessed} onChange={(e) => resetPage(setOnlyAssessed)(!!e.target.checked)} style={{ height: 32 }}>只看参与考核的客服</Checkbox>
        </div>
      </div>

      <div className="list-toolbar">
        {data && (
          <div className="footnote">
            共 {data.total} 个会话；客户评价 {data.summary.reviewed} 个
            {data.summary.reviewed ? `，平均 ${data.summary.avgStar} 星，差评 ${data.summary.bad} 个` : ''}；
            AI 已评 {data.summary.aiScored} 个{data.summary.aiScored ? `，平均 ${data.summary.aiAvg} 分` : ''}。点客户名复制，点行看聊天记录和评分。
          </div>
        )}
        <div style={{ marginLeft: 'auto' }}>
          {jobRunning
            ? <BatchProgress job={job!} deptCode={dept.code} onCancelled={reloadJob} />
            : <Button theme="solid" disabled={noProject || !data?.total} onClick={() => setBatchOpen(true)}>批量 AI 评分</Button>}
        </div>
      </div>

      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <Table
          rowKey="sessionId"
          columns={columns}
          dataSource={data?.list || []}
          loading={loading}
          onRow={(r?: SessionItem) => ({ onClick: () => r && open(r), style: { cursor: 'pointer' } })}
          empty={status && !status.lastSuccess ? '还没有同步过数据。平台启动 1 分钟后会自动同步本月的会话，也可以点右上角「同步数据」。' : '这个条件下没有会话'}
          pagination={{
            currentPage: page,
            pageSize,
            total: data?.total || 0,
            showSizeChanger: true,
            pageSizeOpts: [20, 50, 100],
            onPageChange: setPage,
            onPageSizeChange: (s: number) => { setPageSize(s); setPage(1) },
            style: { padding: '12px 16px' }
          }}
        />
      </div>

      <SessionDrawer deptCode={dept.code} session={detail} onClose={() => setDetail(null)} onScoreChange={applyScore} />
      {dept.groupChat && <IssueDrawer deptCode={dept.code} id={issueId} onClose={() => setIssueId(null)} onChanged={() => void load()} />}
      <SyncModal deptCode={dept.code} visible={syncOpen} status={status} onClose={() => setSyncOpen(false)} onStarted={reloadStatus} />
      <BatchScoreModal
        deptCode={dept.code}
        visible={batchOpen}
        filter={filter}
        rangeText={`${ymd(range[0])} ~ ${ymd(range[1])}${member !== '' ? ' · 指定客服' : ''}${aiFilter || star || channel !== '' || kwApplied ? ' · 有其他筛选' : ''}`}
        onClose={() => setBatchOpen(false)}
        onStarted={reloadJob}
      />
    </div>
  )
}

export default SessionsPage
