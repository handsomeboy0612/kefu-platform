/**
 * 客服成员：从 SaleSmartly 拉取、分部门、班次、是否参与考核。
 *
 * - 成员按 (SaleSmartly 项目, sys_user_id) 存；部门看的是自己 SaleSmartly 设置里那个项目的成员
 * - 一个人只属于一个部门。第一次拉到时按分组名自动分（技术支持 / 研发等 → 技术支持部，其余 → 客服部），
 *   之后只有总管理员能改
 * - 班次存 NULL 表示按分组名自动判断；参与考核默认开
 * - 这次拉取没有出现的人标记为「已不在项目」（离职 / 移出），自动不参与考核；以后又出现会恢复
 */
import { execute, now, query } from './db'
import { listDepartments, type Department } from './auth'
import { getDeptSetting } from './settings'
import { SalesmartlyClient } from './services/salesmartly'

export type ShiftKey = 'day' | 'evening' | 'night' | 'unknown'
export const SHIFT_KEYS: ShiftKey[] = ['day', 'evening', 'night', 'unknown']
export const SHIFT_LABELS: Record<ShiftKey, string> = { day: '白班', evening: '晚班', night: '通宵班', unknown: '未分组' }

/** 分组名里有这些字的，第一次拉到时默认分到技术支持部（和原桌面版客服部 main 分支排除的分组一致） */
const TECH_GROUP_RE = /技术支持|技术组|研发|开发/

/** 分组名 → 班次（和原桌面版一致） */
export function autoShift(groupNames: string): ShiftKey {
  if (/通宵|夜班/.test(groupNames)) return 'night'
  if (/晚/.test(groupNames)) return 'evening'
  if (/白|早/.test(groupNames)) return 'day'
  return 'unknown'
}

export interface MemberRow {
  id: number
  project_id: string
  sys_user_id: number
  nickname: string
  email: string
  group_names: string
  department_id: number | null
  shift: ShiftKey | null
  participate: number
  active: number
  first_seen_at: number
  last_seen_at: number
  updated_at: number
  updated_by: string
}

export interface MemberView {
  id: number
  sysUserId: number
  nickname: string
  email: string
  groupNames: string
  departmentCode: string | null
  departmentName: string
  /** 手动指定的班次；null = 自动 */
  shift: ShiftKey | null
  autoShift: ShiftKey
  /** 实际生效的班次 */
  effectiveShift: ShiftKey
  participate: boolean
  active: boolean
  /** 实际是否参与考核：已不在项目的人一律不参与 */
  effectiveParticipate: boolean
  firstSeenAt: number
  lastSeenAt: number
}

export function toView(r: MemberRow, depts: Department[]): MemberView {
  const d = depts.find((x) => x.id === r.department_id)
  const auto = autoShift(r.group_names)
  return {
    id: r.id,
    sysUserId: Number(r.sys_user_id),
    nickname: r.nickname,
    email: r.email,
    groupNames: r.group_names,
    departmentCode: d?.code ?? null,
    departmentName: d?.name ?? '',
    shift: r.shift,
    autoShift: auto,
    effectiveShift: r.shift || auto,
    participate: !!r.participate,
    active: !!r.active,
    effectiveParticipate: !!r.participate && !!r.active,
    firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at)
  }
}

/** 部门当前 SaleSmartly 项目 ID（没配返回空串） */
export async function deptProjectId(dept: Department): Promise<string> {
  return (await getDeptSetting(dept.code, 'salesmartly')).projectId
}

/**
 * 新成员默认分到哪个部门：只在用同一个 SaleSmartly 项目的部门里挑。
 * 分组名像技术支持的 → 技术支持部；其余 → 客服部；挑不出来就归发起拉取的部门。
 */
async function pickDepartment(projectId: string, groupNames: string, puller: Department): Promise<number> {
  const depts = await listDepartments()
  const sameProject: Department[] = []
  for (const d of depts) if ((await deptProjectId(d)) === projectId) sameProject.push(d)
  const want = TECH_GROUP_RE.test(groupNames) ? 'tech' : 'cs'
  return (sameProject.find((d) => d.kpiTemplate === want) ?? puller).id
}

export interface PullResult {
  projectId: string
  total: number
  added: number
  left: number
  back: number
}

/** 用某部门的 SaleSmartly 设置拉一次成员，写进 members 表 */
export async function pullMembers(dept: Department): Promise<PullResult> {
  const cfg = await getDeptSetting(dept.code, 'salesmartly')
  const list = await new SalesmartlyClient(cfg).getAllMembers()
  if (!list.length) throw new Error('SaleSmartly 返回的成员是空的，先不更新，免得把所有人都标成已离开')

  const t = now()
  const existing = await query<MemberRow>('SELECT * FROM members WHERE project_id = ?', [cfg.projectId])
  const byUid = new Map(existing.map((m) => [Number(m.sys_user_id), m]))
  let added = 0
  let back = 0

  for (const m of list) {
    const groupNames = (m.groups || []).map((g) => g.group_name).filter(Boolean).join('、').slice(0, 500)
    const old = byUid.get(Number(m.sys_user_id))
    if (!old) {
      const deptId = await pickDepartment(cfg.projectId, groupNames, dept)
      await execute(
        `INSERT INTO members (project_id, sys_user_id, nickname, email, group_names, department_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cfg.projectId, m.sys_user_id, m.nickname || '', m.email || '', groupNames, deptId, t, t]
      )
      added++
    } else {
      if (!old.active) back++
      await execute(
        'UPDATE members SET nickname = ?, email = ?, group_names = ?, active = 1, last_seen_at = ? WHERE id = ?',
        [m.nickname || '', m.email || '', groupNames, t, old.id]
      )
    }
  }

  // 这次没出现的人：已不在项目里
  const seen = new Set(list.map((m) => Number(m.sys_user_id)))
  const gone = existing.filter((m) => m.active && !seen.has(Number(m.sys_user_id)))
  for (const m of gone) await execute('UPDATE members SET active = 0 WHERE id = ?', [m.id])

  return { projectId: cfg.projectId, total: list.length, added, left: gone.length, back }
}
