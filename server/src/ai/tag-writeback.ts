/**
 * AI 评级写回 SaleSmartly 会话标签（从桌面版搬过来）。只在部门的「AI 评分写回会话标签」打开时才写。
 *
 * 标签是三级结构：一级分类「AI质检」→ 二级分类「评级」→ 标签「AI-优秀」等。
 * 第一次写的时候自动建缺的分类和标签，ID 按项目缓存在内存里。
 * 写回失败只记日志，不影响评分（评分以平台为准）。
 */
import { SalesmartlyClient } from '../services/salesmartly'
import type { SalesmartlySettings } from '../settings'

const PRIMARY = 'AI质检'
const SECONDARY = '评级'
const TAG_NAMES: Record<string, string> = {
  优秀: 'AI-优秀',
  良好: 'AI-良好',
  合格: 'AI-合格',
  待改进: 'AI-待改进',
  不合格: 'AI-不合格'
}

const cache = new Map<string, Promise<Record<string, number>>>()

async function ensureTags(client: SalesmartlyClient): Promise<Record<string, number>> {
  const wanted = Object.values(TAG_NAMES)
  const found: Record<string, number> = {}
  const existing = await client.getSessionTags('AI-')
  for (const t of existing) if (wanted.includes(t.tag_name)) found[t.tag_name] = t.id
  const missing = wanted.filter((n) => !(n in found))
  if (missing.length) {
    let secondaryId = existing.find((t) => wanted.includes(t.tag_name))?.category_id || 0
    if (!secondaryId) {
      let primaryId = (await client.getTagCategories(0, PRIMARY)).find((c) => c.category_name === PRIMARY)?.id || 0
      if (!primaryId) primaryId = await client.addTagCategory(PRIMARY, 0)
      secondaryId = (await client.getTagCategories(primaryId, SECONDARY)).find((c) => c.category_name === SECONDARY)?.id || 0
      if (!secondaryId) secondaryId = await client.addTagCategory(SECONDARY, primaryId)
    }
    for (const name of missing) found[name] = await client.addSessionTag(name, secondaryId)
  }
  return found
}

/** 先删掉这个会话上所有 AI 评级标签，再加上当前评级（不用 replace，免得删掉人工打的业务标签） */
async function writeGrade(cfg: SalesmartlySettings, sessionId: string, grade: string): Promise<void> {
  const tagName = TAG_NAMES[grade]
  if (!tagName) return
  const client = new SalesmartlyClient(cfg)
  let p = cache.get(cfg.projectId)
  if (!p) {
    p = ensureTags(client)
    cache.set(cfg.projectId, p)
    p.catch(() => cache.delete(cfg.projectId))
  }
  const ids = await p
  await client.tagSession(sessionId, Object.values(ids), 'delete')
  await client.tagSession(sessionId, [ids[tagName]], 'append')
}

/** 评分完成后调用：开关关着就什么都不做；出错只记日志 */
export function writeGradeSafe(cfg: SalesmartlySettings, sessionId: string, grade: string): void {
  if (!cfg.writeBackTags || !cfg.apiToken) return
  writeGrade(cfg, sessionId, grade).catch((err: Error) => {
    console.error(`[tag] 会话 ${sessionId} 评级标签写回失败：${err.message}`)
  })
}
