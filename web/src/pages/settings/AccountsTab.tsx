import React, { useCallback, useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Select, Table, Toast } from '@douyinfe/semi-ui'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { copyText, fmtTime } from '../../utils'

interface Account {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'manager'
  departmentCode: string | null
  departmentName: string
  mustChangePassword: boolean
  disabled: boolean
  createdAt: number
  lastLoginAt: number
}

/** 新密码只显示这一次 */
const PasswordReveal: React.FC<{ info: { title: string; username: string; password: string } | null; onClose: () => void }> = ({ info, onClose }) => {
  const copy = async (): Promise<void> => {
    if (!info) return
    const ok = await copyText(`用户名：${info.username}\n初始密码：${info.password}`)
    if (ok) Toast.success('已复制')
    else Toast.warning('复制失败，请手动选中复制')
  }
  return (
    <Modal title={info?.title} visible={!!info} onCancel={onClose} footer={
      <>
        <Button onClick={copy}>复制用户名和密码</Button>
        <Button theme="solid" onClick={onClose}>我记下了</Button>
      </>
    }>
      {info && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="secret-box">
            <div><span className="form-label">用户名</span><code>{info.username}</code></div>
            <div><span className="form-label">初始密码</span><code>{info.password}</code></div>
          </div>
          <div className="notice">这个密码只显示这一次，关掉就看不到了。请私下发给本人，对方首次登录必须改掉。</div>
        </div>
      )}
    </Modal>
  )
}

/** 账号管理：只有总管理员能看到 */
const AccountsTab: React.FC = () => {
  const { user, departments } = useAuth()
  const [list, setList] = useState<Account[] | null>(null)
  const [reveal, setReveal] = useState<{ title: string; username: string; password: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ displayName: '', username: '', departmentCode: '' })
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(() => {
    api<Account[]>('/api/accounts').then(setList).catch((err) => Toast.error((err as Error).message))
  }, [])
  useEffect(load, [load])

  const resetPassword = async (a: Account): Promise<void> => {
    try {
      const r = await api<{ username: string; password: string }>(`/api/accounts/${a.id}/reset-password`, { body: {} })
      setReveal({ title: `已重置 ${a.displayName} 的密码`, ...r })
      load()
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }

  const toggleDisabled = async (a: Account): Promise<void> => {
    try {
      await api(`/api/accounts/${a.id}/disabled`, { body: { disabled: !a.disabled } })
      Toast.success(a.disabled ? `已启用 ${a.displayName}` : `已停用 ${a.displayName}`)
      load()
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }

  const create = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const r = await api<{ username: string; password: string }>('/api/accounts', { body: form })
      setCreating(false)
      setForm({ displayName: '', username: '', departmentCode: '' })
      setReveal({ title: `已创建 ${form.displayName} 的账号`, ...r })
      load()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const columns = [
    { title: '姓名', dataIndex: 'displayName', width: 140 },
    { title: '用户名', dataIndex: 'username', width: 160 },
    { title: '角色', dataIndex: 'role', width: 110, render: (r: string) => (r === 'admin' ? '总管理员' : '部门主管') },
    { title: '部门', dataIndex: 'departmentName', width: 130, render: (v: string) => v || '全部' },
    {
      title: '状态', key: 'status', width: 120,
      render: (_: unknown, a: Account) => a.disabled
        ? <span className="pill-tag danger">已停用</span>
        : a.mustChangePassword
          ? <span className="pill-tag muted">待改初始密码</span>
          : <span className="pill-tag success">正常</span>
    },
    { title: '最近登录', dataIndex: 'lastLoginAt', width: 170, render: (v: number) => fmtTime(v, '从未登录') },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, a: Account) => a.id === user?.id ? <span className="form-hint" style={{ margin: 0 }}>当前账号</span> : (
        <div style={{ display: 'flex', gap: 8 }}>
          <Popconfirm title={`重置 ${a.displayName} 的密码？`} content="会生成一个新的随机密码，对方当前的登录全部失效。" onConfirm={() => resetPassword(a)}>
            <Button size="small">重置密码</Button>
          </Popconfirm>
          <Popconfirm
            title={a.disabled ? `启用 ${a.displayName}？` : `停用 ${a.displayName}？`}
            content={a.disabled ? '启用后可以用原来的密码登录。' : '停用后立刻下线，不能再登录；数据不会删除。'}
            onConfirm={() => toggleDisabled(a)}
          >
            <Button size="small" type={a.disabled ? 'primary' : 'danger'}>{a.disabled ? '启用' : '停用'}</Button>
          </Popconfirm>
        </div>
      )
    }
  ]

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title" style={{ margin: 0 }}>平台账号</div>
          <Button theme="solid" onClick={() => setCreating(true)}>新建主管账号</Button>
        </div>
        <div className="panel-desc">只有总管理员和两个部门的主管能登录。主管只能看到自己部门的数据。</div>
        <Table rowKey="id" columns={columns} dataSource={list || []} loading={!list} pagination={false} size="middle" />
        <div className="footnote" style={{ marginTop: 16 }}>
          忘记密码时在这里重置，新密码只显示一次。账号不删除，不用了就停用，历史操作记录会保留。
        </div>
      </div>

      <Modal
        title="新建主管账号"
        visible={creating}
        onCancel={() => setCreating(false)}
        onOk={create}
        okText="创建"
        confirmLoading={submitting}
        okButtonProps={{ disabled: !form.displayName.trim() || !form.username.trim() || !form.departmentCode }}
      >
        <div className="stack" style={{ gap: 4 }}>
          <span className="form-label">姓名</span>
          <Input value={form.displayName} onChange={(v) => setForm({ ...form, displayName: v })} placeholder="例如 王智" />
          <span className="form-label">用户名</span>
          <Input value={form.username} onChange={(v) => setForm({ ...form, username: v })} placeholder="登录用，字母或数字，例如 wangzhi" />
          <span className="form-label">部门</span>
          <Select
            value={form.departmentCode || undefined}
            placeholder="选择部门"
            onChange={(v) => setForm({ ...form, departmentCode: String(v) })}
            optionList={departments.map((d) => ({ value: d.code, label: d.name }))}
            style={{ width: '100%' }}
          />
          <div className="form-hint">创建后会生成一个随机初始密码，只显示一次。</div>
        </div>
      </Modal>

      <PasswordReveal info={reveal} onClose={() => setReveal(null)} />
    </div>
  )
}

export default AccountsTab
