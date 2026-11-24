import React from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { Empty, Select, Spin, Typography } from '@douyinfe/semi-ui'
import {
  IconBarChartVStroked, IconComment, IconExit, IconKey, IconRankingCardStroked, IconSetting, IconUserGroup
} from '@douyinfe/semi-icons'
import { AuthProvider, useAuth } from './auth'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import appIcon from './assets/icon.png'

const { Text } = Typography

/** 一期搬迁中的页面占位 */
const Placeholder: React.FC<{ title: string }> = ({ title }) => {
  const { dept } = useAuth()
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Empty title={`${title}`} description={`${dept?.name || ''} · 正在从桌面版迁移`} />
    </div>
  )
}

interface NavItem { path: string; text: string; icon: React.ReactNode; groupChatOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/sessions', text: '会话记录', icon: <IconComment /> },
  { path: '/dashboard', text: '统计看板', icon: <IconBarChartVStroked /> },
  { path: '/kpi', text: '绩效考核', icon: <IconRankingCardStroked /> },
  { path: '/group', text: '对公群', icon: <IconUserGroup />, groupChatOnly: true },
  { path: '/settings', text: '设置', icon: <IconSetting /> }
]

const Shell: React.FC = () => {
  const { user, departments, dept, setDeptCode, logout } = useAuth()
  if (!user) return null
  const items = NAV_ITEMS.filter((i) => !i.groupChatOnly || dept?.groupChat)

  return (
    <div className="app-layout">
      <div className="app-sidebar">
        <div className="app-sidebar-logo">
          <div className="app-sidebar-logo-icon">
            <img src={appIcon} alt="logo" style={{ width: '100%', height: '100%' }} />
          </div>
          <div className="app-sidebar-logo-text">
            <h2>客服考核</h2>
            <span className="app-sidebar-badge">数据平台</span>
          </div>
        </div>

        {/* 部门：总管理员可切换，主管固定为自己部门 */}
        <div style={{ padding: '4px 12px 8px' }}>
          {user.role === 'admin' && departments.length > 1 ? (
            <Select
              value={dept?.code}
              onChange={(v) => setDeptCode(String(v))}
              style={{ width: '100%' }}
              optionList={departments.map((d) => ({ value: d.code, label: d.name }))}
            />
          ) : (
            <Text strong style={{ paddingLeft: 4 }}>{dept?.name || '未绑定部门'}</Text>
          )}
        </div>

        <nav className="app-nav">
          <div className="app-nav-group">工作台</div>
          {items.map((item) => (
            <NavLink key={item.path} to={item.path} className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}>
              <span className="app-nav-icon">{item.icon}</span>
              <span className="app-nav-text">{item.text}</span>
            </NavLink>
          ))}
          <NavLink to="/password" className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}>
            <span className="app-nav-icon"><IconKey /></span>
            <span className="app-nav-text">修改密码</span>
          </NavLink>
        </nav>

        <div className="app-sidebar-footer">
          <div className="app-account-card">
            <span className="app-conn-dot" />
            <div className="app-account-info">
              <span className="app-account-name">{user.displayName}</span>
              <span className="app-account-sub">{user.role === 'admin' ? '总管理员' : `${dept?.name || ''}主管`}</span>
            </div>
            <button className="app-logout-btn" title="退出登录" onClick={logout}>
              <IconExit size="small" />
            </button>
          </div>
        </div>
      </div>

      <div className="app-main">
        {/* 切换部门时整页重建，避免带着上个部门的数据 */}
        <React.Fragment key={dept?.code}>
          <Routes>
            <Route path="/sessions" element={<Placeholder title="会话记录" />} />
            <Route path="/dashboard" element={<Placeholder title="统计看板" />} />
            <Route path="/kpi" element={<Placeholder title="绩效考核" />} />
            <Route path="/group" element={dept?.groupChat ? <Placeholder title="对公群" /> : <Navigate to="/sessions" replace />} />
            <Route path="/settings" element={<Placeholder title="设置" />} />
            <Route path="/password" element={<ChangePasswordPage />} />
            <Route path="*" element={<Navigate to="/sessions" replace />} />
          </Routes>
        </React.Fragment>
      </div>
    </div>
  )
}

const Gate: React.FC = () => {
  const { user } = useAuth()
  if (user === undefined) {
    return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" /></div>
  }
  if (user === null) return <LoginPage />
  if (user.mustChangePassword) return <ChangePasswordPage forced />
  return <Shell />
}

const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <Gate />
    </AuthProvider>
  </BrowserRouter>
)

export default App
