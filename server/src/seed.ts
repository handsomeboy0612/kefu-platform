/**
 * 首次启动初始化：两个部门 + 三个账号（总管理员、客服部主管、技术支持部主管）。
 * 账号只在 accounts 表为空时创建；随机初始密码写到 data/initial-accounts.txt（不提交 git），
 * 首次登录必须改密码，改完即可删除该文件。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'
import { config } from './config'
import { execute, now, query } from './db'

const DEPARTMENTS = [
  { code: 'cs', name: '客服部', kpiTemplate: 'cs', groupChat: 0, sort: 1 },
  { code: 'tech', name: '技术支持部', kpiTemplate: 'tech', groupChat: 1, sort: 2 }
]

const INITIAL_ACCOUNTS = [
  { username: 'admin', displayName: '总管理员', role: 'admin', dept: null as string | null },
  { username: 'zhongmengling', displayName: '钟孟玲', role: 'manager', dept: 'cs' },
  { username: 'wangzhi', displayName: '王智', role: 'manager', dept: 'tech' }
]

export function randomPassword(): string {
  // 去掉易混淆字符（0/O、1/l/I），方便口头转告
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(12)
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

export async function seed(): Promise<void> {
  for (const d of DEPARTMENTS) {
    await execute(
      `INSERT IGNORE INTO departments (code, name, kpi_template, group_chat, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [d.code, d.name, d.kpiTemplate, d.groupChat, d.sort, now()]
    )
  }

  const [{ n }] = await query<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')
  if (n > 0) return

  const depts = await query<{ id: number; code: string }>('SELECT id, code FROM departments')
  const deptId = (code: string | null): number | null => (code ? depts.find((d) => d.code === code)?.id ?? null : null)
  const lines = [
    '客服考核数据平台 · 初始账号（首次登录必须修改密码，改完请删除本文件）',
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ''
  ]
  for (const a of INITIAL_ACCOUNTS) {
    const password = randomPassword()
    await execute(
      `INSERT INTO accounts (username, display_name, role, department_id, password_hash, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [a.username, a.displayName, a.role, deptId(a.dept), await bcrypt.hash(password, 10), now()]
    )
    lines.push(`${a.displayName}（${a.role === 'admin' ? '总管理员' : '部门主管'}）  用户名：${a.username}  初始密码：${password}`)
  }
  fs.mkdirSync(config.dataDir, { recursive: true })
  const file = path.join(config.dataDir, 'initial-accounts.txt')
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
  console.log(`[seed] 已创建 ${INITIAL_ACCOUNTS.length} 个初始账号，初始密码见 ${file}`)
}
