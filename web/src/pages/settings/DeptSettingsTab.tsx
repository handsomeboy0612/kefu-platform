import React, { useEffect, useState } from 'react'
import { Button, Input, Spin, Switch, Toast } from '@douyinfe/semi-ui'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { fmtTime } from '../../utils'

type SectionKey = 'salesmartly' | 'ai' | 'archive'

interface FieldDef {
  key: string
  label: string
  type: 'text' | 'secret' | 'switch'
  placeholder?: string
  hint?: string
}

interface SectionDef {
  key: SectionKey
  title: string
  desc: string
  fields: FieldDef[]
  footnote: string
}

/** 接口返回的一节：密钥字段已打码成 xxxSet / xxxTail */
interface SectionData {
  value: Record<string, unknown>
  meta: { updatedAt: number; updatedBy: string } | null
  configured: boolean
}

const SECTIONS: SectionDef[] = [
  {
    key: 'salesmartly',
    title: 'SaleSmartly',
    desc: '本部门的会话、成员和满意度从这个项目拉。两个部门填同一个项目也可以，各算各的成员。',
    fields: [
      { key: 'projectId', label: '项目 ID', type: 'text', placeholder: '例如 g1qnrj2' },
      { key: 'apiToken', label: 'API Token', type: 'secret' },
      {
        key: 'writeBackTags', label: 'AI 评分写回会话标签', type: 'switch',
        hint: '开启后，AI 质检结果会作为标签写回 SaleSmartly。桌面版「客服评分系统」还在用的时候先别开，免得两边重复写。'
      }
    ],
    footnote: 'API Token 在 SaleSmartly 后台的开放平台（API）设置里获取。'
  },
  {
    key: 'ai',
    title: 'AI 接口',
    desc: '本部门的 AI 都用这个接口：网页会话的质检评分；开了对公群的部门，群聊整理成群问题（判断处理人、是否解决、交接、投诉等）也用它。用量都算在这个 Key 上。',
    fields: [
      { key: 'apiBase', label: '接口地址', type: 'text', placeholder: 'https://yunwu.ai/v1' },
      { key: 'apiKey', label: 'API Key', type: 'secret' },
      { key: 'model', label: '模型名称', type: 'text', placeholder: 'gpt-5.2' }
    ],
    footnote: '兼容 OpenAI 格式的接口。测试时会按真实评分的参数发一次很短的请求，模型名写错会直接报出来。'
  },
  {
    key: 'archive',
    title: '群聊归档服务',
    desc: '企业微信机器人上传的群聊记录存在这里，对公群从这里拉。',
    fields: [
      { key: 'serverUrl', label: '服务地址', type: 'text', placeholder: 'http://127.0.0.1:8091' },
      { key: 'apiKey', label: 'API Key', type: 'secret' }
    ],
    footnote: '归档服务和平台装在同一台电脑上，地址一般不用改。API Key 就是 D:\\wecom-archive\\.env 里的 API_KEY。'
  }
]

/** 表单初始值：普通字段用已保存的值，密钥字段一律空（留空 = 不修改） */
function initialForm(def: SectionDef, data: SectionData): Record<string, unknown> {
  const f: Record<string, unknown> = {}
  for (const field of def.fields) f[field.key] = field.type === 'secret' ? '' : data.value[field.key]
  return f
}

const SectionCard: React.FC<{ deptCode: string; def: SectionDef; data: SectionData; onSaved: (d: SectionData) => void }> = ({ deptCode, def, data, onSaved }) => {
  const [form, setForm] = useState<Record<string, unknown>>(() => initialForm(def, data))
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const dirty = def.fields.some((f) => (f.type === 'secret' ? !!form[f.key] : form[f.key] !== data.value[f.key]))
  const set = (key: string, v: unknown): void => {
    setForm((prev) => ({ ...prev, [key]: v }))
    setResult(null)
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api<{ ok: boolean; message: string }>(`/api/settings/dept/${def.key}/test`, { body: form, query: { dept: deptCode } }))
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await api<SectionData>(`/api/settings/dept/${def.key}`, { method: 'PUT', body: form, query: { dept: deptCode } })
      onSaved(next)
      setForm(initialForm(def, next))
      Toast.success(`${def.title} 已保存`)
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title" style={{ margin: 0 }}>{def.title}</div>
        <span className={`pill-tag ${data.configured ? 'success' : 'muted'}`}>{data.configured ? '已配置' : '未配置'}</span>
      </div>
      <div className="panel-desc">{def.desc}</div>

      <div className="form-grid">
        {def.fields.map((f) => {
          if (f.type === 'switch') {
            return (
              <div key={f.key} className="form-field form-field-wide">
                <div className="form-switch-row">
                  <Switch checked={!!form[f.key]} onChange={(v) => set(f.key, v)} />
                  <span className="form-label" style={{ margin: 0 }}>{f.label}</span>
                </div>
                {f.hint && <div className="form-hint">{f.hint}</div>}
              </div>
            )
          }
          const isSet = !!data.value[`${f.key}Set`]
          const tail = String(data.value[`${f.key}Tail`] || '')
          const placeholder = f.type === 'secret'
            ? (isSet ? `已设置${tail ? `（尾号 ${tail}）` : ''}，不改就留空` : '还没有设置')
            : f.placeholder
          return (
            <div key={f.key} className="form-field">
              <span className="form-label">{f.label}</span>
              <Input
                mode={f.type === 'secret' ? 'password' : undefined}
                value={String(form[f.key] ?? '')}
                placeholder={placeholder}
                onChange={(v) => set(f.key, v)}
                autoComplete={f.type === 'secret' ? 'new-password' : 'off'}
              />
            </div>
          )
        })}
      </div>

      <div className="form-actions">
        <Button loading={testing} onClick={test}>测试连接</Button>
        <Button theme="solid" loading={saving} disabled={!dirty} onClick={save}>保存</Button>
        {dirty && <span className="form-hint" style={{ margin: 0 }}>有改动还没保存</span>}
      </div>
      {result && <div className={`notice ${result.ok ? 'success' : 'error'}`}>{result.message}</div>}

      <div className="footnote" style={{ marginTop: 16 }}>
        {def.footnote}
        {data.meta && <> 最近修改：{fmtTime(data.meta.updatedAt)} · {data.meta.updatedBy}</>}
      </div>
    </div>
  )
}

/** 部门的数据源与 AI：SaleSmartly / AI 接口 / 群聊归档服务（只有开了对公群的部门有） */
const DeptSettingsTab: React.FC = () => {
  const { dept } = useAuth()
  const [data, setData] = useState<Partial<Record<SectionKey, SectionData>> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!dept) return
    api<Partial<Record<SectionKey, SectionData>>>('/api/settings/dept', { query: { dept: dept.code } })
      .then(setData)
      .catch((err) => setError((err as Error).message))
  }, [dept])

  if (!dept) return <div className="notice error">账号没有绑定部门</div>
  if (error) return <div className="notice error">{error}</div>
  if (!data) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>

  return (
    <div className="stack">
      {SECTIONS.filter((def) => data[def.key]).map((def) => (
        <SectionCard
          key={def.key}
          deptCode={dept.code}
          def={def}
          data={data[def.key]!}
          onSaved={(d) => setData((prev) => (prev ? { ...prev, [def.key]: d } : prev))}
        />
      ))}
    </div>
  )
}

export default DeptSettingsTab
