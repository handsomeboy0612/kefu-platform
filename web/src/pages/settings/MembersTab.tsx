import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Empty, Input, RadioGroup, Radio, Select, Spin, Switch, Table, Toast } from '@douyinfe/semi-ui'
import { IconSearch } from '@douyinfe/semi-icons'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { fmtTime } from '../../utils'

type ShiftKey = 'day' | 'evening' | 'night' | 'unknown'
const SHIFT_LABELS: Record<ShiftKey, string> = { day: '白班', evening: '晚班', night: '通宵班', unknown: '未分组' }

interface Member {
  id: number
  sysUserId: number
  nickname: string
  email: string
  groupNames: string
  departmentCode: string | null
  departmentName: string
  shift: ShiftKey | null
  autoShift: ShiftKey
  effectiveShift: ShiftKey
  participate: boolean
  active: boolean
  effectiveParticipate: boolean
}

interface ListResp { projectId: string; list: Member[]; lastPulledAt: number }
interface PullResp { total: number; added: number; left: number; back: number }

/** 成员：从 SaleSmartly 拉取，设班次、是否参与考核；总管理员还能分部门 */
const MembersTab: React.FC = () => {
  const { user, dept, departments } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [data, setData] = useState<ListResp | null>(null)
  const [scope, setScope] = useState<'dept' | 'all'>('dept')
  const [keyword, setKeyword] = useState('')
  const [pulling, setPulling] = useState(false)
  const [savingId, setSavingId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!dept) return
    try {
      setData(await api<ListResp>('/api/members', { query: { dept: dept.code, scope } }))
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }, [dept, scope])
  useEffect(() => { void load() }, [load])

  const pull = async (): Promise<void> => {
    if (!dept) return
    setPulling(true)
    try {
      const r = await api<PullResp>('/api/members/pull', { body: {}, query: { dept: dept.code } })
      const parts = [`共 ${r.total} 人`]
      if (r.added) parts.push(`新增 ${r.added} 人`)
      if (r.left) parts.push(`${r.left} 人已不在项目`)
      if (r.back) parts.push(`${r.back} 人重新出现`)
      Toast.success(`已从 SaleSmartly 拉取：${parts.join('，')}`)
      await load()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setPulling(false)
    }
  }

  const update = async (m: Member, patch: Record<string, unknown>): Promise<void> => {
    if (!dept) return
    setSavingId(m.id)
    try {
      const next = await api<Member>(`/api/members/${m.id}`, { method: 'PUT', body: patch, query: { dept: dept.code } })
      setData((prev) => {
        if (!prev) return prev
        // 管理员在「本部门」视图里把人分走了，就从列表里拿掉
        const gone = scope === 'dept' && next.departmentCode !== dept.code
        return { ...prev, list: gone ? prev.list.filter((x) => x.id !== m.id) : prev.list.map((x) => (x.id === m.id ? next : x)) }
      })
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSavingId(null)
    }
  }

  const list = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!data) return []
    if (!k) return data.list
    return data.list.filter((m) => `${m.nickname} ${m.email} ${m.groupNames}`.toLowerCase().includes(k))
  }, [data, keyword])

  const stats = useMemo(() => {
    const l = data?.list || []
    return {
      total: l.length,
      participate: l.filter((m) => m.effectiveParticipate).length,
      inactive: l.filter((m) => !m.active).length
    }
  }, [data])

  if (!dept) return null
  if (!data) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
  if (!data.projectId) {
    return <div className="notice">本部门还没有填 SaleSmartly 项目，先到「数据源与 AI」里填好再来拉成员。</div>
  }

  const columns = [
    {
      title: '客服', dataIndex: 'nickname', width: 220,
      render: (_: unknown, m: Member) => (
        <div>
          <div style={{ fontWeight: 500 }}>{m.nickname || `（无昵称）${m.sysUserId}`}</div>
          <div className="form-hint" style={{ margin: 0 }}>{m.email || m.sysUserId}</div>
        </div>
      )
    },
    { title: 'SaleSmartly 分组', dataIndex: 'groupNames', render: (v: string) => v || <span className="form-hint">—</span> },
    ...(isAdmin ? [{
      title: '部门', dataIndex: 'departmentCode', width: 150,
      render: (_: unknown, m: Member) => (
        <Select
          size="small"
          value={m.departmentCode ?? ''}
          disabled={savingId === m.id}
          style={{ width: 128 }}
          optionList={[...departments.map((d) => ({ value: d.code, label: d.name })), { value: '', label: '未分配' }]}
          onChange={(v) => update(m, { departmentCode: v || null })}
        />
      )
    }] : []),
    {
      title: '班次', dataIndex: 'shift', width: 170,
      render: (_: unknown, m: Member) => (
        <Select
          size="small"
          value={m.shift ?? 'auto'}
          disabled={savingId === m.id}
          style={{ width: 150 }}
          optionList={[
            { value: 'auto', label: `自动（${SHIFT_LABELS[m.autoShift]}）` },
            ...(Object.keys(SHIFT_LABELS) as ShiftKey[]).map((k) => ({ value: k, label: SHIFT_LABELS[k] }))
          ]}
          onChange={(v) => update(m, { shift: v === 'auto' ? null : v })}
        />
      )
    },
    {
      title: '参与考核', dataIndex: 'participate', width: 110,
      render: (_: unknown, m: Member) => (
        <Switch
          size="small"
          checked={m.effectiveParticipate}
          disabled={!m.active || savingId === m.id}
          onChange={(v) => update(m, { participate: v })}
        />
      )
    },
    {
      title: '状态', dataIndex: 'active', width: 120,
      render: (v: boolean) => v
        ? <span className="pill-tag success">在项目里</span>
        : <span className="pill-tag muted">已不在项目</span>
    }
  ]

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title" style={{ margin: 0 }}>成员</div>
        <Button theme="solid" loading={pulling} onClick={pull}>从 SaleSmartly 拉取</Button>
      </div>
      <div className="panel-desc">
        {scope === 'all' ? '这个 SaleSmartly 项目里的全部成员' : `${dept.name}的成员`}：共 {stats.total} 人，参与考核 {stats.participate} 人
        {stats.inactive ? `，${stats.inactive} 人已不在项目` : ''}。最近拉取：{fmtTime(data.lastPulledAt, '还没拉过')}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <Input prefix={<IconSearch />} placeholder="搜昵称、邮箱、分组" value={keyword} onChange={setKeyword} showClear style={{ width: 280 }} />
        {isAdmin && (
          <RadioGroup type="button" value={scope} onChange={(e) => setScope(e.target.value as 'dept' | 'all')}>
            <Radio value="dept">只看{dept.name}</Radio>
            <Radio value="all">项目全部成员（分部门）</Radio>
          </RadioGroup>
        )}
      </div>

      {data.list.length === 0 ? (
        <Empty
          title={data.lastPulledAt ? '本部门还没有成员' : '还没有拉取过成员'}
          description={data.lastPulledAt
            ? (isAdmin ? '切到「项目全部成员」，把人分到这个部门。' : '请总管理员把人分到本部门。')
            : '点右上角「从 SaleSmartly 拉取」。'}
          style={{ padding: '32px 0' }}
        />
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={list}
          pagination={false}
          size="middle"
          onRow={(m?: Member) => ({ className: m && !m.active ? 'row-inactive' : '' })}
        />
      )}

      <div className="footnote" style={{ marginTop: 16, lineHeight: 1.9 }}>
        <div>班次默认按 SaleSmartly 分组名判断：含「通宵 / 夜班」是通宵班，含「晚」是晚班，含「白 / 早」是白班，都没有就是未分组；可以手动改。</div>
        <div>不参与考核的人会话照样记录，但不算进看板和绩效。已经不在 SaleSmartly 项目里的人（离职、移出）自动不参与。</div>
        <div>一个人只属于一个部门。第一次拉到时，分组名带「技术支持 / 技术组 / 研发 / 开发」的分到技术支持部，其余分到客服部，之后由总管理员调整。</div>
      </div>
    </div>
  )
}

export default MembersTab
