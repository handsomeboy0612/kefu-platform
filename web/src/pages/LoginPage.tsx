import React, { useState } from 'react'
import { Button, Input, Toast } from '@douyinfe/semi-ui'
import { useAuth } from '../auth'
import { api } from '../api'

const LoginPage: React.FC = () => {
  const { refresh } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (): Promise<void> => {
    if (!username.trim() || !password) {
      Toast.warning('请输入用户名和密码')
      return
    }
    setLoading(true)
    try {
      await api('/api/auth/login', { body: { username: username.trim(), password } })
      await refresh()
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-surface">
      <div className="login-column">
        <div className="login-brand">
          <div className="brand-mark">考核</div>
          <div className="login-brand-title">客服考核<br />数据平台</div>
        </div>
        <div className="login-card">
          <span className="login-label">用户名</span>
          <Input size="large" value={username} onChange={setUsername} onEnterPress={submit} autoFocus />
          <span className="login-label">密码</span>
          <Input size="large" mode="password" value={password} onChange={setPassword} onEnterPress={submit} />
          <Button className="login-submit" theme="solid" block loading={loading} onClick={submit}>登录</Button>
        </div>
        <div className="login-footer">客服部、技术支持部主管账号。忘记密码请联系总管理员重置，所有操作会记录账号名。</div>
      </div>
    </div>
  )
}

export default LoginPage
