/**
 * 部门设置接口（SaleSmartly / AI 接口 / 群聊归档服务）。
 * 主管只能读写自己部门，总管理员可以操作任意部门（请求带 dept = 部门 code）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { audit, HttpError, resolveDepartment, type Department } from '../auth'
import {
  getDeptSettingWithMeta, isDeptSection, isSectionConfigured, maskSetting, mergeSettingInput,
  saveDeptSetting, SECRET_FIELDS, sectionsFor, type DeptSection, type DeptSettings
} from '../settings'
import { testSalesmartly } from '../services/salesmartly'
import { testAI } from '../services/ai'
import { testArchive } from '../services/archive'

/** 解析部门和设置项；这个部门没有的项（如客服部的群聊归档）当作不存在 */
async function resolve(req: FastifyRequest): Promise<{ dept: Department; section: DeptSection }> {
  const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
  const section = (req.params as { section: string }).section
  if (!isDeptSection(section) || !sectionsFor(dept).includes(section)) throw new HttpError(404, '这个部门没有这一项设置')
  return { dept, section }
}

async function sectionView(deptCode: string, section: DeptSection): Promise<Record<string, unknown>> {
  const { value, meta } = await getDeptSettingWithMeta(deptCode, section)
  return { value: maskSetting(section, value), meta, configured: isSectionConfigured(section, value) }
}

async function runTest(section: DeptSection, v: DeptSettings[DeptSection]): Promise<{ ok: boolean; message: string }> {
  switch (section) {
    case 'salesmartly': return testSalesmartly(v as DeptSettings['salesmartly'])
    case 'ai': return testAI(v as DeptSettings['ai'])
    case 'archive': return testArchive(v as DeptSettings['archive'])
  }
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  /** 本部门全部设置（密钥打码） */
  app.get('/api/settings/dept', async (req) => {
    const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
    const data: Record<string, unknown> = {}
    for (const s of sectionsFor(dept)) data[s] = await sectionView(dept.code, s)
    return { success: true, data }
  })

  /** 保存一项。密钥字段留空 = 不修改 */
  app.put('/api/settings/dept/:section', async (req) => {
    const user = req.user!
    const { dept, section } = await resolve(req)
    const input = (req.body || {}) as Record<string, unknown>
    const { value: saved } = await getDeptSettingWithMeta(dept.code, section)
    const next = mergeSettingInput(section, saved, input)
    await saveDeptSetting(dept.code, section, next, user.username)

    // 日志里只记改了哪些字段，密钥只记「已更换」
    const changed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(next as unknown as Record<string, unknown>)) {
      if ((saved as unknown as Record<string, unknown>)[k] === v) continue
      changed[k] = SECRET_FIELDS[section].includes(k) ? '（已更换）' : v
    }
    await audit(req, 'settings_update', `${dept.code}:${section}`, changed, dept.id)
    return { success: true, data: await sectionView(dept.code, section) }
  })

  /**
   * 测试连接。表单里还没保存的值优先（密钥留空就用已保存的），方便先测再存。
   * 不会保存任何东西。
   */
  app.post('/api/settings/dept/:section/test', async (req) => {
    const { dept, section } = await resolve(req)
    const input = (req.body || {}) as Record<string, unknown>
    const { value: saved } = await getDeptSettingWithMeta(dept.code, section)
    return { success: true, data: await runTest(section, mergeSettingInput(section, saved, input)) }
  })
}
