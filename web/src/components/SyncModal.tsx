import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DatePicker, Modal, Progress, Table, Toast } from '@douyinfe/semi-ui'
import { api } from '../api'
import { fmtTime } from '../utils'

interface Run {
  id: number
  trigger: 'auto' | 'manual'
  triggeredBy: string
  rangeBegin: number
  rangeEnd: number
  status: 'running' | 'success' | 'failed'
  startedAt: number
  finishedAt: number
  sessionsFetched: number
  sessionsNew: number
  messagesSynced: number
  messagesFailed: number
  error: string | null
}

export interface SyncStatus {
  projectId: string
  autoIntervalMin: number
  progress: { runId: number; phase: 'members' | 'sessions' | 'messages'; done: number; total: number; startedAt: number } | null
  lastSuccess: Run | null
  runs: Run[]
  messagesGivenUp: number
}

const PHASE_TEXT = { members: '刷新成员名单', sessions: '拉取会话', messages: '拉取聊天记录' }

const day = (sec: number): string => fmtTime(sec).slice(0, 10)

/** 同步状态用的 hook：同步进行中每 2 秒刷新一次，跑完回调 onFinished */
export function useSyncStatus(deptCode: string | undefined, onFinished?: () => void): { status: SyncStatus | null; reload: () => void } {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const wasRunning = useRef(false)
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished

  const reload = useCallback(() => {
    if (!deptCode) return
    api<SyncStatus>('/api/sync/status', { query: { dept: deptCode } })
      .then((s) => {
        setStatus(s)
        if (wasRunning.current && !s.progress) finishedRef.current?.()
        wasRunning.current = !!s.progress
      })
      .catch(() => { /* 状态拉不到不影响页面 */ })
  }, [deptCode])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (!status?.progress) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [status?.progress, reload])

  return { status, reload }
}

/** 同步进度条（页头和弹窗里都用） */
export const SyncProgressLine: React.FC<{ p: NonNullable<SyncStatus['progress']> }> = ({ p }) => {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  return (
    <div style={{ minWidth: 260 }}>
      <div style={{ fontSize: 12, color: 'var(--app-blue)' }}>
        正在同步 · {PHASE_TEXT[p.phase]}{p.total ? ` ${p.done}/${p.total}` : ''}
      </div>
      <Progress percent={pct} size="small" stroke="var(--app-blue)" style={{ marginTop: 4 }} />
    </div>
  )
}

/** 同步弹窗：手动同步一段时间 + 最近的同步记录 */
const SyncModal: React.FC<{ deptCode: string; visible: boolean; status: SyncStatus | null; onClose: () => void; onStarted: () => void }> = ({ deptCode, visible, status, onClose, onStarted }) => {
  const [range, setRange] = useState<[Date, Date] | null>(null)
  const [starting, setStarting] = useState(false)

  const start = async (): Promise<void> => {
    if (!range) return void Toast.warning('先选时间段')
    const begin = Math.floor(new Date(range[0].getFullYear(), range[0].getMonth(), range[0].getDate()).getTime() / 1000)
    const end = Math.floor(new Date(range[1].getFullYear(), range[1].getMonth(), range[1].getDate(), 23, 59, 59).getTime() / 1000)
    setStarting(true)
    try {
      await api('/api/sync/run', { body: { begin, end }, query: { dept: deptCode } })
      Toast.success('已开始同步，可以关掉这个窗口，同步在后台跑')
      onStarted()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const columns = [
    { title: '开始', dataIndex: 'startedAt', width: 150, render: (v: number) => <span style={{ whiteSpace: 'nowrap' }}>{fmtTime(v)}</span> },
    { title: '方式', dataIndex: 'trigger', width: 130, render: (v: string, r: Run) => (v === 'auto' ? '自动' : `手动 · ${r.triggeredBy}`) },
    { title: '时间段', key: 'range', width: 200, render: (_: unknown, r: Run) => <span style={{ whiteSpace: 'nowrap' }}>{day(r.rangeBegin)} ~ {day(r.rangeEnd)}</span> },
    {
      title: '结果', dataIndex: 'status', width: 90,
      render: (v: string) => v === 'success'
        ? <span className="pill-tag success">成功</span>
        : v === 'running' ? <span className="pill-tag">进行中</span> : <span className="pill-tag danger">失败</span>
    },
    {
      title: '内容', key: 'detail',
      render: (_: unknown, r: Run) => r.status === 'failed'
        ? <span style={{ color: '#8E3420' }}>{r.error}</span>
        : r.status === 'running' ? '—'
          : `会话 ${r.sessionsFetched}（新 ${r.sessionsNew}），聊天记录 ${r.messagesSynced}${r.messagesFailed ? `，失败 ${r.messagesFailed}` : ''}`
    }
  ]

  return (
    <Modal title="同步 SaleSmartly 数据" visible={visible} onCancel={onClose} footer={null} width={980}>
      <div className="stack" style={{ gap: 16, paddingBottom: 16 }}>
        <div className="notice">
          平台每 {status?.autoIntervalMin ?? 60} 分钟自动同步一次最近 3 天的会话，平时不用手动点。
          需要补更早的数据（比如核对上个月绩效）时，在这里选时间段同步。两个部门用同一个 SaleSmartly 项目时，这份数据是共用的。
        </div>
        {status?.progress ? (
          <SyncProgressLine p={status.progress} />
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <DatePicker
              type="dateRange"
              value={range ?? undefined}
              onChange={(v) => setRange(Array.isArray(v) && v.length === 2 ? [v[0] as Date, v[1] as Date] : null)}
              disabledDate={(d) => !!d && d.getTime() > Date.now()}
              style={{ width: 280 }}
            />
            <Button theme="solid" loading={starting} onClick={start}>立即同步</Button>
            <span className="form-hint" style={{ margin: 0 }}>按会话开始时间，一次最多 62 天</span>
          </div>
        )}
        {!!status?.messagesGivenUp && (
          <div className="form-hint" style={{ margin: 0 }}>
            有 {status.messagesGivenUp} 个会话的聊天记录连续 3 次没拉下来，不再自动重试；点开会话时会再拉一次。
          </div>
        )}
        <Table rowKey="id" columns={columns} dataSource={status?.runs || []} pagination={false} size="small" empty="还没有同步过" />
      </div>
    </Modal>
  )
}

export default SyncModal
