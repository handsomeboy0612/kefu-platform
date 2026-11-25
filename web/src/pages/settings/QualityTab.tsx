import React, { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Spin, Switch, TextArea, Toast } from '@douyinfe/semi-ui'
import { IconDelete, IconPlus } from '@douyinfe/semi-icons'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { fmtTime } from '../../utils'

interface Dimension { name: string; weight: number }
interface QualityResp {
  value: { prompt: string; dimensions: Dimension[]; autoNightly: boolean }
  isDefault: boolean
  updatedAt: number
  updatedBy: string
  defaults: { prompt: string; dimensions: Dimension[] }
}

/** AI 质检：本部门的评分提示词、维度和权重、每晚自动评分 */
const QualityTab: React.FC = () => {
  const { dept } = useAuth()
  const [data, setData] = useState<QualityResp | null>(null)
  const [prompt, setPrompt] = useState('')
  const [dims, setDims] = useState<Dimension[]>([])
  const [auto, setAuto] = useState(false)
  const [saving, setSaving] = useState(false)

  const fill = (d: QualityResp): void => {
    setData(d)
    setPrompt(d.value.prompt)
    setDims(d.value.dimensions.map((x) => ({ ...x })))
    setAuto(d.value.autoNightly)
  }

  useEffect(() => {
    if (!dept) return
    api<QualityResp>('/api/quality', { query: { dept: dept.code } }).then(fill).catch((err) => Toast.error((err as Error).message))
  }, [dept])

  if (!dept) return null
  if (!data) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>

  const sum = dims.reduce((s, d) => s + (Number(d.weight) || 0), 0)
  const dirty = prompt !== data.value.prompt || auto !== data.value.autoNightly || JSON.stringify(dims) !== JSON.stringify(data.value.dimensions)
  const isDefaultForm = prompt === data.defaults.prompt && JSON.stringify(dims) === JSON.stringify(data.defaults.dimensions)

  const setDim = (i: number, patch: Partial<Dimension>): void => setDims((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await api<QualityResp>('/api/quality', { method: 'PUT', body: { prompt, dimensions: dims, autoNightly: auto }, query: { dept: dept.code } })
      fill({ ...next, defaults: data.defaults })
      Toast.success('AI 质检设置已保存，之后的评分按新设置来')
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title" style={{ margin: 0 }}>评分维度和权重</div>
          <span className={`pill-tag ${sum === 100 ? 'success' : 'danger'}`}>合计 {sum}%</span>
        </div>
        <div className="panel-desc">AI 给每个维度打 0~100 分，平台按权重算总分，再按总分定评级：90 以上优秀、75 以上良好、60 以上合格、40 以上待改进、其余不合格。</div>
        <div className="dim-editor">
          {dims.map((d, i) => (
            <div key={i} className="dim-editor-row">
              <Input value={d.name} onChange={(v) => setDim(i, { name: v })} placeholder="维度名称" style={{ width: 200 }} />
              <InputNumber value={d.weight} min={1} max={100} onChange={(v) => setDim(i, { weight: Number(v) || 0 })} suffix="%" style={{ width: 120 }} />
              <Button icon={<IconDelete />} theme="borderless" type="tertiary" disabled={dims.length <= 1} onClick={() => setDims(dims.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button icon={<IconPlus />} theme="borderless" disabled={dims.length >= 10} onClick={() => setDims([...dims, { name: '', weight: 0 }])} style={{ alignSelf: 'flex-start' }}>
            加一个维度
          </Button>
        </div>
        <div className="footnote" style={{ marginTop: 12 }}>维度名称要和提示词里写的一致，AI 是按这些名称返回分数的。</div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title" style={{ margin: 0 }}>评分提示词</div>
          <span className="form-hint" style={{ margin: 0 }}>{prompt.length} 字</span>
        </div>
        <div className="panel-desc">
          写清楚评分标准、各维度怎么打分、哪些情况扣分加分。平台会在每次评分时自动加上会话结束状态、响应时间分析、转接识别、发言统计这些预分析，
          以及统一的输出格式（各维度得分、亮点、问题、评语、改进建议），提示词里不用再写输出格式。
        </div>
        <TextArea value={prompt} onChange={setPrompt} autosize={{ minRows: 14, maxRows: 32 }} style={{ fontSize: 13, lineHeight: 1.7 }} />
      </div>

      <div className="panel">
        <div className="form-switch-row">
          <Switch checked={auto} onChange={setAuto} />
          <span className="form-label" style={{ margin: 0, color: 'var(--app-text-1)' }}>每晚 01:00 自动评前一天的会话</span>
        </div>
        <div className="form-hint" style={{ marginTop: 8 }}>
          只评参与考核的客服、客户发过言、还没评过的会话；评分用的是本部门的 AI 接口和额度。
          桌面版还在评分的时候先别开，免得两边重复花钱。没开的话，可以在「会话记录」里按筛选范围批量评。
        </div>
      </div>

      <div className="form-actions" style={{ marginTop: 0 }}>
        <Button theme="solid" loading={saving} disabled={!dirty || sum !== 100} onClick={save}>保存</Button>
        <Button disabled={isDefaultForm} onClick={() => { setPrompt(data.defaults.prompt); setDims(data.defaults.dimensions.map((x) => ({ ...x }))) }}>恢复默认提示词和维度</Button>
        {dirty && <span className="form-hint" style={{ margin: 0 }}>有改动还没保存</span>}
        <span className="footnote" style={{ marginLeft: 'auto' }}>
          {data.isDefault ? '现在用的是默认设置（和原桌面版一致）' : `最近修改：${fmtTime(data.updatedAt)} · ${data.updatedBy}`}
        </span>
      </div>
    </div>
  )
}

export default QualityTab
