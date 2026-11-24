import React, { useState } from 'react'
import { Button, Input, Toast, Typography } from '@douyinfe/semi-ui'
import { useAuth } from '../auth'
import { api } from '../api'
import appIcon from '../assets/icon.png'

const { Title, Text } = Typography

const cardStyle: React.CSSProperties = {
  width: 380, padding: '36px 32px', background: '#fff', borderRadius: 12,
  boxShadow: 'var(--app-shadow-3)', display: 'flex', flexDirection: 'column', gap: 14
}

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
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--app-sidebar-bg)' }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <img src={appIcon} alt="" style={{ width: 36, height: 36 }} />
          <div>
            <Title heading={4} style={{ margin: 0 }}>客服考核数据平台</Title>
            <Text type="tertiary" size="small">客服部 · 技术支持部</Text>
          </div>
        </div>
        <Input size="large" placeholder="用户名" value={username} onChange={setUsername} onEnterPress={submit} autoFocus />
        <Input size="large" mode="password" placeholder="密码" value={password} onChange={setPassword} onEnterPress={submit} />
        <Button theme="solid" size="large" block loading={loading} onClick={submit}>登录</Button>
        <Text type="tertiary" size="small">忘记密码请联系总管理员重置</Text>
      </div>
    </div>
  )
}

export default LoginPage
