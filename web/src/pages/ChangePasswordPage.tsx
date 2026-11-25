import React, { useState } from 'react'
import { Button, Input, Toast } from '@douyinfe/semi-ui'
import { useAuth } from '../auth'
import { api } from '../api'
import PageHeader from '../components/PageHeader'

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

  const fields = (
    <>
      <span className="login-label">原密码</span>
      <Input size="large" mode="password" value={oldPassword} onChange={setOld} />
      <span className="login-label">新密码（至少 8 位）</span>
      <Input size="large" mode="password" value={newPassword} onChange={setNew} />
      <span className="login-label">再输一次新密码</span>
      <Input size="large" mode="password" value={confirm} onChange={setConfirm} onEnterPress={submit} />
      <Button className="login-submit" theme="solid" block loading={loading} onClick={submit}>确认修改</Button>
    </>
  )

  if (!forced) {
    return (
      <div className="page">
        <PageHeader title="修改密码" desc="改完后，其他地方登录的这个账号会被退出。" />
        <div className="login-card" style={{ width: 416 }}>{fields}</div>
      </div>
    )
  }
  return (
    <div className="login-surface">
      <div className="login-column">
        <div className="login-brand">
          <div className="brand-mark">考核</div>
          <div className="login-brand-title">客服考核<br />数据平台</div>
        </div>
        <div className="info-banner">{user?.displayName}，首次登录请先把初始密码改掉。</div>
        <div className="login-card">{fields}</div>
        <Button theme="borderless" type="tertiary" onClick={logout} style={{ alignSelf: 'flex-start' }}>退出登录</Button>
      </div>
    </div>
  )
}

export default ChangePasswordPage
