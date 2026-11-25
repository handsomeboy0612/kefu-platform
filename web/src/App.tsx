import React from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { Button, Empty, Select, Spin } from '@douyinfe/semi-ui'
import { AuthProvider, useAuth } from './auth'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import PageHeader from './components/PageHeader'
import SettingsPage from './pages/SettingsPage'
import SessionsPage from './pages/SessionsPage'
import DashboardPage from './pages/DashboardPage'
import KpiPage from './pages/kpi/KpiPage'

/** 一期还没做好的页面占位 */
const Placeholder: React.FC<{ title: string; desc: string }> = ({ title, desc }) => {
  const { dept } = useAuth()
  return (
    <div className="page">
      <PageHeader title={title} desc={desc} scope={dept?.name} />
      <div className="panel" style={{ padding: '64px 24px' }}>
        <Empty title="这个页面还在开发中" description="功能会从原来的「客服评分系统」桌面版搬过来" />
      </div>
    </div>
  )
}

interface NavItem { path: string; text: string; desc: string; groupChatOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { path: '/sessions', text: '会话记录', desc: '查看 SaleSmartly 会话和 AI 质检评分，按客服、时间、评分筛选。' },
  { path: '/dashboard', text: '统计看板', desc: '按客服看接待量、首响时长和质检得分的变化。' },
  { path: '/kpi', text: '绩效考核', desc: '按本部门的考核规则，汇总每位客服的得分。' },
  { path: '/group', text: '对公群', desc: '企业微信对公群里谁解决了什么问题、回复了多少次。', groupChatOnly: true },
  { path: '/settings', text: '设置', desc: '数据源、AI 接口、成员和考核规则。' }
]

/** 已经做好的页面；没在这里的先显示占位 */
const PAGES: Record<string, React.ReactNode> = {
  '/sessions': <SessionsPage />,
  '/dashboard': <DashboardPage />,
  '/kpi': <KpiPage />,
  '/settings': <SettingsPage />
}

const Shell: React.FC = () => {
  const { user, departments, dept, setDeptCode, logout } = useAuth()
  const navigate = useNavigate()
  if (!user) return null
  const items = NAV_ITEMS.filter((i) => !i.groupChatOnly || dept?.groupChat)
  const roleText = user.role === 'admin' ? '总管理员' : `${dept?.name || ''}主管`

  return (
    <div className="app-layout">
      <div className="app-sidebar">
        <div className="app-sidebar-logo">
          <div className="brand-mark">考核</div>
          <div className="app-sidebar-logo-text">
            <h2>客服考核数据平台</h2>
            <span className="app-sidebar-badge">SaleSmartly · 企业微信群</span>
          </div>
        </div>

        <nav className="app-nav">
          {items.map((item) => (
            <NavLink key={item.path} to={item.path} className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}>
              {item.text}
            </NavLink>
          ))}
        </nav>

        {/* 部门：总管理员可切换，主管固定为自己部门 */}
        <div className="app-side-section">
          <span className="app-side-label">{user.role === 'admin' ? '查看部门' : '所属部门'}</span>
          {user.role === 'admin' && departments.length > 1 ? (
            <Select
              value={dept?.code}
              onChange={(v) => setDeptCode(String(v))}
              style={{ width: '100%' }}
              optionList={departments.map((d) => ({ value: d.code, label: d.name }))}
            />
          ) : (
            <span className="pill-tag" style={{ alignSelf: 'flex-start' }}>{dept?.name || '未绑定部门'}</span>
          )}
          <span className="app-side-hint">两个部门的成员、数据和考核规则互相独立。</span>
        </div>

        <div className="app-side-section" style={{ marginBottom: 32 }}>
          <span className="app-side-meta">当前账号：<b>{user.displayName}</b></span>
          <span className="app-side-meta">{roleText}</span>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button size="small" onClick={() => navigate('/password')}>修改密码</Button>
            <Button size="small" onClick={logout}>退出登录</Button>
          </div>
        </div>
      </div>

      <div className="app-main">
        {/* 切换部门时整页重建，避免带着上个部门的数据 */}
        <React.Fragment key={dept?.code}>
          <Routes>
            {items.map((item) => (
              <Route key={item.path} path={item.path} element={PAGES[item.path] ?? <Placeholder title={item.text} desc={item.desc} />} />
            ))}
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
