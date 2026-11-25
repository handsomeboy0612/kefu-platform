import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Progress, Spin, Toast } from '@douyinfe/semi-ui'
import { api } from '../api'

export interface BatchJob {
  id: number
  kind: 'manual' | 'nightly'
  by: string
  total: number
  done: number
  ok: number
  failed: number
  startedAt: number
  finishedAt: number
  cancelled: boolean
  abortReason: string
  errors: Array<{ sessionId: string; customerName: string; error: string }>
}

interface Preview {
  total: number
  eligible: number
  scored: number
  noCustomer: number
  notAssessed: number
  avgTokens: number
  model: string
  aiConfigured: boolean
  max: number
}

/** 批量评分进度：进行中每 2 秒刷新；结束时回调 onFinished(job) */
export function useBatchJob(deptCode: string | undefined, onFinished?: (job: BatchJob) => void): { job: BatchJob | null; reload: () => void } {
  const [job, setJob] = useState<BatchJob | null>(null)
  const running = useRef(false)
  const cb = useRef(onFinished)
  cb.current = onFinished

  const reload = useCallback(() => {
    if (!deptCode) return
    api<BatchJob | null>('/api/scores/batch', { query: { dept: deptCode } })
      .then((j) => {
        setJob(j)
        if (running.current && j?.finishedAt) cb.current?.(j)
        running.current = !!j && !j.finishedAt
      })
      .catch(() => { /* 拿不到进度不影响页面 */ })
  }, [deptCode])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (!job || job.finishedAt) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [job, reload])
  return { job, reload }
}

/** 列表上方的进度条 */
export const BatchProgress: React.FC<{ job: BatchJob; deptCode: string; onCancelled: () => void }> = ({ job, deptCode, onCancelled }) => {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
  const cancel = async (): Promise<void> => {
    try {
      await api('/api/scores/batch/cancel', { body: {}, query: { dept: deptCode } })
      Toast.info('已取消，正在评的几个跑完就停')
      onCancelled()
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 360 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--app-blue)' }}>
          {job.kind === 'nightly' ? '每晚自动评分' : '批量 AI 评分'}中 {job.done}/{job.total}
          {job.failed ? `，失败 ${job.failed}` : ''}{job.cancelled ? '（取消中）' : ''}
        </div>
        <Progress percent={pct} size="small" stroke="var(--app-blue)" style={{ marginTop: 4 }} />
      </div>
      {!job.cancelled && <Button size="small" onClick={cancel}>取消</Button>}
    </div>
  )
}

/** 批量评分确认弹窗：先预览范围，确认后开始 */
const BatchScoreModal: React.FC<{
  deptCode: string
  visible: boolean
  filter: Record<string, unknown>
  rangeText: string
  onClose: () => void
  onStarted: () => void
}> = ({ deptCode, visible, filter, rangeText, onClose, onStarted }) => {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!visible) return
    setPreview(null)
    setError('')
    api<Preview>('/api/scores/batch/preview', { body: filter, query: { dept: deptCode } })
      .then(setPreview)
      .catch((err) => setError((err as Error).message))
  }, [visible, deptCode, filter])

  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      await api('/api/scores/batch', { body: filter, query: { dept: deptCode } })
      Toast.success('批量评分已开始，在后台跑，可以继续看别的')
      onStarted()
      onClose()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const tooMany = !!preview && preview.eligible > preview.max
  const estTokens = preview && preview.avgTokens ? preview.avgTokens * preview.eligible : 0

  return (
    <Modal
      title="批量 AI 评分"
      visible={visible}
      onCancel={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button theme="solid" loading={starting} disabled={!preview || !preview.eligible || tooMany || !preview.aiConfigured} onClick={start}>
            {preview?.eligible ? `开始评分（${preview.eligible} 个）` : '开始评分'}
          </Button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      {!preview && !error && <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>}
      {preview && (
        <div className="stack" style={{ gap: 12, paddingBottom: 8 }}>
          <div className="form-hint" style={{ margin: 0 }}>范围：当前列表的筛选条件（{rangeText}），共 {preview.total} 个会话。</div>
          <div className="batch-preview">
            <div><b>{preview.eligible}</b><span>这次会评</span></div>
            <div><em>{preview.scored}</em><span>已经评过</span></div>
            <div><em>{preview.noCustomer}</em><span>客户没说话，跳过</span></div>
            <div><em>{preview.notAssessed}</em><span>客服不参与考核，跳过</span></div>
          </div>
          {!preview.aiConfigured && <div className="notice error">本部门还没有配好 AI 接口，先到「设置 → 数据源与 AI」填好。</div>}
          {tooMany && <div className="notice error">一次最多评 {preview.max} 个，请缩小日期范围或加筛选条件。</div>}
          <div className="notice">
            用本部门的 AI 接口（模型 {preview.model}）评分，同时评 5 个，每个十几秒到一分钟。
            {estTokens ? ` 按之前的平均用量，这次大约消耗 ${(estTokens / 10000).toFixed(1)} 万 tokens。` : ''}
            评过的不会重复评；评分失败的可以再点一次批量评分重试。
          </div>
        </div>
      )}
    </Modal>
  )
}

export default BatchScoreModal
