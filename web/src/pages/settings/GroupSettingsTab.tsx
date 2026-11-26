import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, DatePicker, Input, InputNumber, Modal, Radio, RadioGroup, Select, Spin, Table, TabPane, Tabs, Toast } from '@douyinfe/semi-ui'
import { IconSearch } from '@douyinfe/semi-icons'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { fmtTime } from '../../utils'

interface GroupConfig { roomFilterMode: 'keyword' | 'manual'; roomKeyword: string; selectedRooms: string[]; gapMin: number }
interface Run {
  id: number; trigger: string; triggeredBy: string; rangeBegin: number; rangeEnd: number; status: string
  startedAt: number; finishedAt: number; error: string | null
  detail: { rooms: number; messages: number; sessions: number; skippedOpen: number; skippedNoOwner: number; removed: number; gaps: Array<{ agent_name: string; start: number; end: number; seconds: number }>; warnings: string[] } | null
}
interface Status {
  archive: { configured: boolean; ok?: boolean; error?: string; msgTotal?: number; groups?: number; agents?: Array<{ name: string; lastUploadAt: number; online: boolean }> }
  config: GroupConfig
  progress: { phase: string; done: number; total: number } | null
  sessionTotal: number
  lastMessageAt: number
  runs: Run[]
}
interface Staff { userId: string; nickname: string; rawName: string; sysUserId: number; manual: boolean; lastSeenAt: number; memberName: string; counted: boolean }
interface Room { roomId: string; roomName: string; memberCount: number; msgTotal: number; lastMsgAt: number; internal: boolean }

const TECH_RE = /技术支持|技术组|研发|开发/

const PHASE = { rooms: '筛选群', messages: '拉群消息', save: '切段、存群会话' } as Record<string, string>
const day = (sec: number): string => fmtTime(sec).slice(0, 10)
const dur = (sec: number): string => (sec >= 3600 ? `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分` : `${Math.round(sec / 60)} 分钟`)

/** 员工挂靠：群里说过话的员工 → SaleSmartly 成员 */
const StaffTab: React.FC<{ deptCode: string }> = ({ deptCode }) => {
  const [data, setData] = useState<{ staff: Staff[]; members: Array<{ sysUserId: number; nickname: string; inDept: boolean }> } | null>(null)
  const [kw, setKw] = useState('')
  const load = useCallback(() => {
    api<typeof data>('/api/group/staff', { query: { dept: deptCode } }).then(setData).catch((e) => Toast.error((e as Error).message))
  }, [deptCode])
  useEffect(load, [load])
  if (!data) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>

  const save = async (s: Staff, v: number | null): Promise<void> => {
    try {
      await api(`/api/group/staff/${encodeURIComponent(s.userId)}`, { method: 'PUT', body: { sysUserId: v }, query: { dept: deptCode } })
      Toast.success('已保存，下次同步（或点「立即同步」）后生效')
      load()
    } catch (e) {
      Toast.error((e as Error).message)
    }
  }
  // 先看计入的，再看像技术支持却没挂上的，其余（商务、渠道等）放后面
  const rank = (s: Staff): number => (s.counted ? 0 : s.sysUserId ? 1 : TECH_RE.test(s.nickname) ? 2 : 3)
  const list = data.staff
    .filter((s) => !kw || `${s.nickname} ${s.rawName} ${s.memberName}`.includes(kw))
    .sort((a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt)
  const options = [
    { value: -1, label: '自动匹配' },
    { value: 0, label: '不是我们的人（不计入）' },
    ...data.members.map((m) => ({ value: m.sysUserId, label: m.inDept ? m.nickname : `${m.nickname}（其他部门）` }))
  ]
  const columns = [
    { title: '群里的员工', dataIndex: 'nickname', render: (v: string, s: Staff) => <div><b style={{ fontWeight: 500 }}>{v || s.rawName}</b>{s.rawName && s.rawName !== v && <div className="kpi-cell-sub">个人昵称：{s.rawName}</div>}</div> },
    {
      title: '对应的成员', key: 'map', width: 260,
      render: (_: unknown, s: Staff) => (
        <Select size="small" filter style={{ width: 230 }} value={s.manual ? s.sysUserId : -1} optionList={options}
          onChange={(v) => void save(s, Number(v) === -1 ? null : Number(v))}
          renderSelectedItem={() => (s.manual ? (s.sysUserId ? `${s.memberName}（手动）` : '不是我们的人（手动）') : s.sysUserId ? `${s.memberName}（自动）` : '没挂上')} />
      )
    },
    {
      title: '计不计入', key: 'counted', width: 150,
      render: (_: unknown, s: Staff) => s.counted ? <span className="pill-tag success">计入</span>
        : s.sysUserId ? <span className="pill-tag muted">不计入（非本部门考核人员）</span> : <span className="pill-tag muted">不计入</span>
    },
    { title: '最近在群里说话', dataIndex: 'lastSeenAt', width: 150, render: (v: number) => fmtTime(v, '—') }
  ]
  return (
    <div className="panel">
      <div className="panel-desc">
        机器人上传的群消息里只有企业微信的昵称，要挂到 SaleSmartly 成员上才知道是谁。平台会按群昵称自动匹配（去掉「技术支持部-」这类前缀后同名优先，再按包含匹配）；
        匹配错了或者没匹配上的，在这里手动指定。只有挂到本部门、勾了「参与考核」的人，回复才算进群会话。
      </div>
      <Input prefix={<IconSearch />} placeholder="搜员工昵称" value={kw} onChange={setKw} showClear style={{ width: 260, marginBottom: 12 }} />
      <Table rowKey="userId" size="middle" columns={columns} dataSource={list} pagination={list.length > 20 ? { pageSize: 20 } : false} />
    </div>
  )
}

/** 群筛选和切段间隔 */
const ConfigTab: React.FC<{ deptCode: string; config: GroupConfig; onSaved: () => void }> = ({ deptCode, config, onSaved }) => {
  const [c, setC] = useState<GroupConfig>(config)
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [kw, setKw] = useState('')
  useEffect(() => { setC(config) }, [config])
  useEffect(() => {
    api<Room[]>('/api/group/rooms', { query: { dept: deptCode } }).then(setRooms).catch((e) => { Toast.error((e as Error).message); setRooms([]) })
  }, [deptCode])

  const included = useMemo(() => {
    if (!rooms) return new Set<string>()
    if (c.roomFilterMode === 'manual') return new Set(c.selectedRooms)
    return new Set(rooms.filter((r) => !r.internal && (!c.roomKeyword || r.roomName.includes(c.roomKeyword))).map((r) => r.roomId))
  }, [rooms, c])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api('/api/group/config', { method: 'PUT', body: c, query: { dept: deptCode } })
      Toast.success('已保存，下次同步生效。想马上看效果点右上角「立即同步」')
      onSaved()
    } catch (e) {
      Toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const toggle = (id: string, on: boolean): void => setC((p) => ({ ...p, selectedRooms: on ? [...new Set([...p.selectedRooms, id])] : p.selectedRooms.filter((x) => x !== id) }))
  const list = (rooms || []).filter((r) => !kw || r.roomName.includes(kw))

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-title">哪些群算对公群</div>
        <RadioGroup value={c.roomFilterMode} onChange={(e) => setC({ ...c, roomFilterMode: e.target.value as GroupConfig['roomFilterMode'] })}>
          <Radio value="keyword">按群名关键词（不填 = 全部群），自动去掉全是员工的内部群</Radio>
          <Radio value="manual">只算下面勾选的群</Radio>
        </RadioGroup>
        {c.roomFilterMode === 'keyword' && (
          <Input value={c.roomKeyword} onChange={(v) => setC({ ...c, roomKeyword: v })} placeholder="群名关键词，可以不填" style={{ width: 300, marginTop: 12 }} />
        )}
        <div className="rule-row" style={{ marginTop: 16 }}>
          <span>切段间隔<em>同一个群里两条消息隔这么久，就算另一段对话（桌面版默认 30 分钟）</em></span>
          <InputNumber value={c.gapMin} min={5} max={240} suffix="分钟" onChange={(v) => setC({ ...c, gapMin: Number(v) || 30 })} style={{ width: 140 }} />
        </div>
        <div className="form-actions"><Button theme="solid" loading={saving} onClick={() => void save()}>保存</Button></div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title" style={{ margin: 0 }}>群列表</div>
          <span className="form-hint" style={{ margin: 0 }}>共 {rooms?.length ?? '…'} 个群，现在算进来的 {included.size} 个</span>
        </div>
        <Input prefix={<IconSearch />} placeholder="搜群名" value={kw} onChange={setKw} showClear style={{ width: 260, margin: '8px 0 12px' }} />
        {!rooms ? <Spin /> : (
          <Table rowKey="roomId" size="small" dataSource={list} pagination={list.length > 20 ? { pageSize: 20 } : false}
            columns={[
              {
                title: '', key: 'sel', width: 60,
                render: (_: unknown, r: Room) => c.roomFilterMode === 'manual'
                  ? <input type="checkbox" checked={c.selectedRooms.includes(r.roomId)} onChange={(e) => toggle(r.roomId, e.target.checked)} />
                  : included.has(r.roomId) ? <span className="pill-tag success">算</span> : <span className="pill-tag muted">不算</span>
              },
              { title: '群名', dataIndex: 'roomName', render: (v: string, r: Room) => <span>{v || r.roomId}{r.internal && <span className="form-hint" style={{ margin: '0 0 0 8px' }}>内部群</span>}</span> },
              { title: '人数', dataIndex: 'memberCount', width: 80 },
              { title: '消息数', dataIndex: 'msgTotal', width: 90 },
              { title: '最近消息', dataIndex: 'lastMsgAt', width: 150, render: (v: number) => fmtTime(v, '—') }
            ]} />
        )}
      </div>
    </div>
  )
}

/** 同步记录：每次同步的结果、挂靠提醒、采集中断 */
const RunsTab: React.FC<{ runs: Run[] }> = ({ runs }) => {
  const last = runs.find((r) => r.status === 'success')
  return (
    <div className="stack">
      {last?.detail?.warnings?.length ? (
        <div className="notice error" style={{ marginTop: 0 }}>
          <b>最近一次同步的提醒</b>
          {last.detail.warnings.map((w) => <div key={w}>· {w}</div>)}
        </div>
      ) : null}
      {last?.detail?.gaps?.length ? (
        <div className="notice" style={{ marginTop: 0 }}>
          <b>机器人采集中断过（这些时间段的群消息可能不全）</b>
          {last.detail.gaps.map((g) => <div key={`${g.agent_name}${g.start}`}>· {g.agent_name}：{fmtTime(g.start)} ~ {fmtTime(g.end)}（{dur(g.seconds)}）</div>)}
        </div>
      ) : null}
      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <Table rowKey="id" size="small" dataSource={runs} pagination={false} empty="还没有同步过"
          columns={[
            { title: '开始', dataIndex: 'startedAt', width: 150, render: (v: number) => <span style={{ whiteSpace: 'nowrap' }}>{fmtTime(v)}</span> },
            { title: '方式', dataIndex: 'trigger', width: 120, render: (v: string, r: Run) => (v === 'auto' ? '自动' : `手动 · ${r.triggeredBy}`) },
            { title: '时间段', key: 'range', width: 200, render: (_: unknown, r: Run) => <span style={{ whiteSpace: 'nowrap' }}>{day(r.rangeBegin)} ~ {day(r.rangeEnd)}</span> },
            { title: '结果', dataIndex: 'status', width: 80, render: (v: string) => (v === 'success' ? <span className="pill-tag success">成功</span> : v === 'running' ? <span className="pill-tag">进行中</span> : <span className="pill-tag danger">失败</span>) },
            {
              title: '内容', key: 'd',
              render: (_: unknown, r: Run) => r.error ? <span style={{ color: '#8E3420' }}>{r.error}</span> : r.detail
                ? `${r.detail.rooms} 个群、${r.detail.messages} 条消息 → 群会话 ${r.detail.sessions} 个；还没聊完 ${r.detail.skippedOpen} 段（下次再存），没有考核人员回复 ${r.detail.skippedNoOwner} 段${r.detail.removed ? `，清掉旧的 ${r.detail.removed} 个` : ''}`
                : '—'
            }
          ]} />
      </div>
    </div>
  )
}

/** 设置 → 对公群：归档服务状态、立即同步、员工挂靠、群筛选与切段、同步记录（只有开了对公群的部门有） */
const GroupSettingsTab: React.FC = () => {
  const { dept } = useAuth()
  const [status, setStatus] = useState<Status | null>(null)
  const [tab, setTab] = useState('staff')
  const [syncOpen, setSyncOpen] = useState(false)
  const [range, setRange] = useState<[Date, Date] | null>(null)
  const [starting, setStarting] = useState(false)
  const wasRunning = useRef(false)

  const load = useCallback(() => {
    if (!dept) return
    api<Status>('/api/group/status', { query: { dept: dept.code } })
      .then((s) => {
        setStatus(s)
        if (wasRunning.current && !s.progress) Toast.success('对公群同步完成')
        wasRunning.current = !!s.progress
      })
      .catch((e) => Toast.error((e as Error).message))
  }, [dept])
  useEffect(load, [load])
  useEffect(() => {
    if (!status?.progress) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [status?.progress, load])

  if (!dept) return null
  const a = status?.archive
  const lastOk = status?.runs.find((r) => r.status === 'success')

  const start = async (): Promise<void> => {
    if (!range) return void Toast.warning('先选时间段')
    setStarting(true)
    try {
      const b = Math.floor(new Date(range[0].getFullYear(), range[0].getMonth(), range[0].getDate()).getTime() / 1000)
      const e = Math.floor(new Date(range[1].getFullYear(), range[1].getMonth(), range[1].getDate(), 23, 59, 59).getTime() / 1000)
      await api('/api/group/sync', { body: { begin: b, end: Math.min(e, Math.floor(Date.now() / 1000)) }, query: { dept: dept.code } })
      setSyncOpen(false)
      Toast.success('已开始同步')
      load()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title" style={{ margin: 0 }}>对公群同步</div>
          <Button onClick={() => setSyncOpen(true)} disabled={!!status?.progress}>立即同步</Button>
        </div>
        <div className="panel-desc" style={{ marginBottom: 0 }}>
          群消息来自企业微信机器人，每 10 分钟自动同步；群聊停下 30 分钟后由 AI 整理成「群问题」，挂到处理人名下（「会话记录」里按来源「对公群」查看）。
          技术支持部第二项按群问题计分；按规则切的「群会话」留作对照（考核规则里可以切回按它计分）。
          {status && <> 规则群会话 {status.sessionTotal} 个；最近同步 {lastOk ? fmtTime(lastOk.finishedAt) : '—'}；</>}
          {a?.configured === false ? '还没配群聊归档服务。' : a?.ok === false ? `归档服务连不上：${a.error}` : (a?.agents || []).map((g) => `采集端 ${g.name}${g.online ? '在线' : '离线'}`).join('、')}
          {status?.progress && <span className="pill-tag" style={{ marginLeft: 8 }}>正在同步 · {PHASE[status.progress.phase] || ''}{status.progress.total ? ` ${status.progress.done}/${status.progress.total}` : ''}</span>}
        </div>
      </div>
      {lastOk?.detail?.warnings?.length ? (
        <div className="notice error" style={{ marginTop: 0 }}>有 {lastOk.detail.warnings.length} 条挂靠提醒，见「同步记录」。</div>
      ) : null}

      <Tabs type="button" activeKey={tab} onChange={setTab} keepDOM={false}>
        <TabPane tab="员工挂靠" itemKey="staff"><div style={{ paddingTop: 16 }}><StaffTab deptCode={dept.code} /></div></TabPane>
        <TabPane tab="群筛选与切段" itemKey="config">
          <div style={{ paddingTop: 16 }}>{status ? <ConfigTab deptCode={dept.code} config={status.config} onSaved={load} /> : <Spin />}</div>
        </TabPane>
        <TabPane tab="同步记录" itemKey="runs"><div style={{ paddingTop: 16 }}><RunsTab runs={status?.runs || []} /></div></TabPane>
      </Tabs>

      <Modal title="同步对公群" visible={syncOpen} onCancel={() => setSyncOpen(false)} onOk={() => void start()} okText="开始同步" confirmLoading={starting}>
        <div className="stack" style={{ gap: 12, paddingBottom: 8 }}>
          <div className="notice" style={{ marginTop: 0 }}>平时每 10 分钟会自动同步，不用手动点。改了员工挂靠或群筛选，想马上看效果，就选时间段重新同步（会按新设置重新切段、挂人）。</div>
          <DatePicker type="dateRange" value={range ?? undefined} style={{ width: 280 }}
            disabledDate={(d) => !!d && d.getTime() > Date.now()}
            onChange={(v) => setRange(Array.isArray(v) && v[0] && v[1] ? [v[0] as Date, v[1] as Date] : null)} />
        </div>
      </Modal>
    </div>
  )
}

export default GroupSettingsTab
