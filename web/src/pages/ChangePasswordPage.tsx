import React, { useState } from 'react'
import { Button, Input, Toast, Typography } from '@douyinfe/semi-ui'
import { useAuth } from '../auth'
import { api } from '../api'

const { Title, Text } = Typography

/** 修改密码：首次登录强制进入；之后也可以从侧边栏进入 */
const ChangePasswordPage: React.FC<{ forced?: boolean; onDone?: () => void }> = ({ forced, onDone }) => {
  const { user, refresh, logout } = useAuth()
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (): Promise<void> => {
    if (newPassword.length < 8) return void Toast.warning('新密码至少 8 位')
    if (newPassword !== confirm) return void Toast.warning('两次输入的新密码不一致')
    setLoading(true)
    try {
      await api('/api/auth/change-password', { body: { oldPassword, newPassword } })
      Toast.success('密码已修改')
      setOld(''); setNew(''); setConfirm('')
      await refresh()
      onDone?.()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const form = (
    <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Title heading={4} style={{ margin: 0 }}>修改密码</Title>
      {forced && <Text type="warning">{user?.displayName}，首次登录请先修改初始密码。</Text>}
      <Input mode="password" placeholder="原密码" value={oldPassword} onChange={setOld} />
      <Input mode="password" placeholder="新密码（至少 8 位）" value={newPassword} onChange={setNew} />
      <Input mode="password" placeholder="再输一次新密码" value={confirm} onChange={setConfirm} onEnterPress={submit} />
      <Button theme="solid" loading={loading} onClick={submit}>确认修改</Button>
      {forced && <Button theme="borderless" type="tertiary" onClick={logout}>退出登录</Button>}
    </div>
  )

  if (!forced) return <div style={{ padding: 32 }}>{form}</div>
  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--app-sidebar-bg)' }}>
      <div style={{ padding: '32px', background: '#fff', borderRadius: 12, boxShadow: 'var(--app-shadow-3)' }}>{form}</div>
    </div>
  )
}

export default ChangePasswordPage
