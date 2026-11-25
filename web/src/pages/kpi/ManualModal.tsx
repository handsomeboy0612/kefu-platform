import React, { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Modal, Switch, Toast } from '@douyinfe/semi-ui'
import { api } from '../../api'
import type { ManualEntry } from './types'

/** 技术支持部每月人工录入：主管评分 + 两大项的投诉 / 扣分（按考核时段开始那天所在的月份） */
const ManualModal: React.FC<{
  deptCode: string
  month: string
  person: { sysUserId: number; name: string } | null
  initial: ManualEntry
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rules: any
  onClose: (saved: boolean) => void
}> = ({ deptCode, month, person, initial, rules, onClose }) => {
  const [e, setE] = useState<ManualEntry>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (person) setE({ ...initial }) }, [person, initial])

  if (!person) return null
  const T = rules?.total || { supervisorMax: 10, supervisorDefault: 7 }
  const D1 = rules?.part1?.deduction || {}
  const S2 = rules?.part2?.satisfaction || {}
  const D2 = rules?.part2?.deduction || {}
  const set = (k: keyof ManualEntry, v: unknown): void => setE((p) => ({ ...p, [k]: v === null || v === '' ? undefined : v }))

  const save = async (entry: ManualEntry | null): Promise<void> => {
    setSaving(true)
    try {
      await api('/api/kpi/manual', { method: 'PUT', body: { month, sysUserId: person.sysUserId, entry }, query: { dept: deptCode } })
      Toast.success(entry ? '已保存' : '已清空，按默认计')
      onClose(true)
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const num = (k: keyof ManualEntry, label: string, hint: string): React.ReactNode => (
    <div className="manual-row">
      <span>{label}<em>{hint}</em></span>
      <InputNumber min={0} max={99} value={e[k] as number | undefined} onChange={(v) => set(k, v === '' ? undefined : Number(v))} style={{ width: 100 }} suffix="次" />
    </div>
  )
  const flag = (k: keyof ManualEntry, label: string, hint: string): React.ReactNode => (
    <div className="manual-row">
      <span>{label}<em>{hint}</em></span>
      <Switch checked={!!e[k]} onChange={(v) => set(k, v || undefined)} />
    </div>
  )

  return (
    <Modal
      title={`${person.name} · ${month} 人工录入`}
      visible
      width={620}
      onCancel={() => onClose(false)}
      footer={
        <>
          <Button type="danger" theme="borderless" onClick={() => void save(null)} style={{ marginRight: 'auto' }}>清空</Button>
          <Button onClick={() => onClose(false)}>取消</Button>
          <Button theme="solid" loading={saving} onClick={() => void save(e)}>保存并重新计算</Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16, paddingBottom: 8 }}>
        <div>
          <div className="manual-title">主管评分</div>
          <div className="manual-row">
            <span>评分<em>0~{T.supervisorMax} 分，不填按 {T.supervisorDefault} 分</em></span>
            <InputNumber min={0} max={T.supervisorMax} step={0.5} value={e.supervisorScore} onChange={(v) => set('supervisorScore', v === '' ? undefined : Number(v))} style={{ width: 100 }} suffix="分" />
          </div>
          <Input placeholder="评语（可选）" value={e.supervisorNote || ''} onChange={(v) => set('supervisorNote', v)} />
        </div>
        <div>
          <div className="manual-title">第一项 · 客服接待</div>
          {num('p1Complaints', '有效投诉', `每次扣 ${D1.complaint ?? 5} 分；当月有投诉不能评 S`)}
          {num('p1UnresolvedBad', '差评没有跟进闭环', `每次扣 ${D1.unresolvedBad ?? 2} 分`)}
          {flag('p1Violation', '违规话术或泄露信息', `扣 ${D1.violation ?? 10} 分，当月不能评 S / A`)}
        </div>
        <div>
          <div className="manual-title">第二项 · 对公群技术售后</div>
          {num('p2Complaints', '有效投诉', `满意度每次扣 ${S2.complaint ?? 5} 分`)}
          {num('p2MildComplaints', '轻度抱怨', `满意度每次扣 ${S2.mild ?? 2} 分`)}
          {num('p2Praise', '客户点名表扬', `每次 +${S2.praise ?? 1}，每月最多 +${S2.praiseCap ?? 3}`)}
          {num('p2Ignored1h', '晾着客户超过 1 小时', `每次扣 ${D2.ignored1h ?? 3} 分`)}
          {num('p2Ignored2h', '晾着超过 2 小时或因此被投诉', `每次扣 ${D2.ignored2h ?? 5} 分`)}
          {num('p2HandoverMiss', '交接遗漏导致客户重复追问', `每次扣 ${D2.handoverMiss ?? 3} 分`)}
          {num('p2WrongInfo', '给错信息造成客户损失', `每次扣 ${D2.wrongInfo ?? 10} 分`)}
          {flag('p2Violation', '违规话术或泄露信息', `扣 ${D2.violation ?? 10} 分，当月不能评 S / A`)}
        </div>
        <div className="form-hint" style={{ margin: 0 }}>每一大项的扣分每月最多扣 {D1.cap ?? 15} 分。录入按月份存，同一个月重新生成报表都会用到。</div>
      </div>
    </Modal>
  )
}

export default ManualModal
