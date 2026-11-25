import React, { useEffect, useState } from 'react'
import { Button, Modal, Spin, Table, Toast } from '@douyinfe/semi-ui'
import { api } from '../../api'
import { channelName } from '../../constants'
import { fmtTime } from '../../utils'
import { Stars } from '../../components/SessionDrawer'
import { fmtSec } from './types'

export interface ExemptTarget {
  kind: 'reply' | 'bad_review'
  sysUserId: number
  name: string
}

interface UnrepliedRow { sessionId: string; customerName: string; channel: number; startTime: number; durationSec: number; customerMsgCount: number; uncached: boolean; graced: boolean; exempt: boolean }
interface ScoredRow { sessionId: string; customerName: string; channel: number; startTime: number; starScore: number; exempt: boolean }

/**
 * 回复率扣分明细 / 满意度评价明细，可以逐条剔除。
 * - 回复率：客户说过话、但人工没回的会话；秒退（存活时间不到宽限）的本来就不扣；复核后不该扣的点「剔除」
 * - 满意度：客户评过分的会话（低星在前）；申诉核实的差评点「剔除」，按真实星级从满意度里去掉
 * 关掉弹窗时如果改过，回调 onChanged 让页面重新生成报表
 */
const ExemptModal: React.FC<{
  deptCode: string
  target: ExemptTarget | null
  range: { begin: number; end: number } | null
  onClose: (changed: boolean) => void
  onOpenSession: (sessionId: string) => void
}> = ({ deptCode, target, range, onClose, onOpenSession }) => {
  const [rows, setRows] = useState<Array<UnrepliedRow | ScoredRow> | null>(null)
  const [graceSec, setGraceSec] = useState(180)
  const [saving, setSaving] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    if (!target || !range) return
    setRows(null)
    setChanged(false)
    const q = { dept: deptCode, member: target.sysUserId, begin: range.begin, end: range.end }
    if (target.kind === 'reply') {
      api<{ graceSec: number; list: UnrepliedRow[] }>('/api/kpi/unreplied', { query: q })
        .then((d) => { setGraceSec(d.graceSec); setRows(d.list) })
        .catch((err) => { Toast.error((err as Error).message); setRows([]) })
    } else {
      api<ScoredRow[]>('/api/kpi/scored', { query: q })
        .then(setRows)
        .catch((err) => { Toast.error((err as Error).message); setRows([]) })
    }
  }, [target, range, deptCode])

  const toggle = async (r: UnrepliedRow | ScoredRow): Promise<void> => {
    if (!target) return
    setSaving(r.sessionId)
    try {
      await api('/api/kpi/exempt', { body: { sessionId: r.sessionId, kind: target.kind, exempt: !r.exempt }, query: { dept: deptCode } })
      setRows((prev) => prev && prev.map((x) => (x.sessionId === r.sessionId ? { ...x, exempt: !r.exempt } : x)))
      setChanged(true)
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSaving(null)
    }
  }

  const isReply = target?.kind === 'reply'
  const common = [
    {
      title: '客户', dataIndex: 'customerName',
      render: (v: string, r: UnrepliedRow | ScoredRow) => <a className="copyable-name" onClick={() => onOpenSession(r.sessionId)}>{v || '—'}</a>
    },
    { title: '渠道', dataIndex: 'channel', width: 90, render: (v: number) => channelName(v) },
    { title: '会话时间', dataIndex: 'startTime', width: 140, render: (v: number) => fmtTime(v).slice(5) }
  ]
  const replyCols = [
    {
      title: '状态', key: 'st', width: 110,
      render: (_: unknown, r: UnrepliedRow) => r.exempt ? <span className="pill-tag success">已剔除</span>
        : r.graced ? <span className="pill-tag muted">秒退不扣</span> : <span className="pill-tag danger">扣分</span>
    },
    ...common,
    { title: '存活时长', dataIndex: 'durationSec', width: 100, render: (v: number) => fmtSec(v) },
    { title: '客户消息', dataIndex: 'customerMsgCount', width: 90 },
    {
      title: '', key: 'op', width: 100,
      render: (_: unknown, r: UnrepliedRow) => r.graced && !r.exempt ? null : (
        <Button size="small" loading={saving === r.sessionId} onClick={() => void toggle(r)}>{r.exempt ? '恢复扣分' : '剔除'}</Button>
      )
    }
  ]
  const scoredCols = [
    {
      title: '状态', key: 'st', width: 100,
      render: (_: unknown, r: ScoredRow) => r.exempt ? <span className="pill-tag success">已剔除</span> : <span className="pill-tag muted">计入</span>
    },
    ...common,
    { title: '星级', dataIndex: 'starScore', width: 130, render: (v: number) => <Stars v={v} /> },
    {
      title: '', key: 'op', width: 100,
      render: (_: unknown, r: ScoredRow) => (r.starScore <= 3 || r.exempt)
        ? <Button size="small" loading={saving === r.sessionId} onClick={() => void toggle(r)}>{r.exempt ? '恢复计入' : '申诉剔除'}</Button>
        : null
    }
  ]

  const deducted = isReply && rows ? (rows as UnrepliedRow[]).filter((r) => !r.graced && !r.exempt).length : 0
  return (
    <Modal
      title={target ? `${target.name} · ${isReply ? '人工回复率扣分明细' : '客户评价明细'}` : ''}
      visible={!!target}
      onCancel={() => onClose(changed)}
      footer={<Button theme="solid" onClick={() => onClose(changed)}>{changed ? '完成并重新计算' : '关闭'}</Button>}
      width={900}
    >
      <div className="form-hint" style={{ margin: '0 0 12px' }}>
        {isReply
          ? `客户说过话、但人工一句都没回的会话。没回且存活不到 ${graceSec} 秒的算秒退，本来就不扣；复核后不该扣的点「剔除」，不进回复率的分母。现在扣分的有 ${deducted} 个。`
          : '客户评过分的会话，低星在前。3 星及以下的差评，申诉核实后可以「申诉剔除」，按真实星级从满意度里去掉。'}
        点客户名看聊天记录。
      </div>
      {!rows ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div> : (
        <Table
          rowKey="sessionId"
          size="small"
          dataSource={rows}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          columns={(isReply ? replyCols : scoredCols) as any}
          pagination={rows.length > 10 ? { pageSize: 10 } : false}
          empty={isReply ? '没有未回复的会话' : '没有客户评价'}
        />
      )}
    </Modal>
  )
}

export default ExemptModal
