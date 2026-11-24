/**
 * 登录态与当前部门。
 * - 主管只有自己一个部门；总管理员可在侧边栏切换部门（记在浏览器本地）
 * - 后续各页面请求数据时带上 dept = 当前部门 code，服务端会再校验一次权限
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, onUnauthorized } from './api'

export interface AuthUser {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'manager'
  departmentId: number | null
  mustChangePassword: boolean
}

export interface Department {
  id: number
  code: string
  name: string
  kpiTemplate: 'cs' | 'tech'
  groupChat: boolean
}

interface AuthState {
  /** undefined = 正在加载；null = 未登录 */
  user: AuthUser | null | undefined
  departments: Department[]
  dept: Department | null
  setDeptCode: (code: string) => void
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)
const DEPT_KEY = 'kp_dept'

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  const [departments, setDepartments] = useState<Department[]>([])
  const [deptCode, setDeptCodeState] = useState<string>(() => localStorage.getItem(DEPT_KEY) || '')

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ user: AuthUser; departments: Department[] }>('/api/auth/me')
      setUser(d.user)
      setDepartments(d.departments)
    } catch {
      setUser(null)
      setDepartments([])
    }
  }, [])

  useEffect(() => {
    refresh()
    return onUnauthorized(() => setUser(null))
  }, [refresh])

  const setDeptCode = useCallback((code: string) => {
    localStorage.setItem(DEPT_KEY, code)
    setDeptCodeState(code)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { body: {} })
    } finally {
      setUser(null)
      setDepartments([])
    }
  }, [])

  const dept = departments.find((d) => d.code === deptCode) || departments[0] || null

  return (
    <AuthContext.Provider value={{ user, departments, dept, setDeptCode, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
