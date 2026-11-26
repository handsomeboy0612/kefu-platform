/**
 * 会话筛选条件 → SQL。会话列表和批量 AI 评分共用，保证「批量评分作用于列表里看到的那些会话」。
 * 表别名：s = ss_sessions，m = members（已按部门 JOIN），sc = ai_scores（LEFT JOIN）。
 */
export interface SessionFilter {
  begin: number | null
  end: number | null
  member: number | null
  channel: number | null
  star: string
  keyword: string
  participate: boolean
  /** scored / unscored / failed */
  score: string
  grade: string
  /** ss = SaleSmartly 在线咨询，wg = 对公群（AI 整理的群问题）；空 = 全部 */
  source: string
}

const int = (v: unknown): number | null => {
  const n = Number(v)
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? Math.trunc(n) : null
}

export function parseFilter(q: Record<string, unknown>): SessionFilter {
  return {
    begin: int(q.begin),
    end: int(q.end),
    member: int(q.member),
    channel: int(q.channel),
    star: String(q.star ?? ''),
    keyword: String(q.keyword ?? '').trim(),
    participate: q.participate === '1' || q.participate === 1 || q.participate === true,
    score: String(q.score ?? ''),
    grade: String(q.grade ?? ''),
    source: q.source === 'ss' || q.source === 'wg' ? String(q.source) : ''
  }
}

/** 公共 FROM：参数顺序是 [部门 id, 项目 id] */
export const SESSION_FROM = `
  FROM ss_sessions s
  JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
  LEFT JOIN ai_scores sc ON sc.project_id = s.project_id AND sc.session_id = s.session_id
  WHERE s.project_id = ?`

export function filterSql(f: SessionFilter): { cond: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (f.begin !== null) { where.push('s.start_time >= ?'); params.push(f.begin) }
  if (f.end !== null) { where.push('s.start_time <= ?'); params.push(f.end) }
  if (f.member !== null) { where.push('s.sys_user_id = ?'); params.push(f.member) }
  if (f.channel !== null) { where.push('s.channel = ?'); params.push(f.channel) }
  switch (f.star) {
    case '': break
    case 'reviewed': where.push('s.star_score > 0'); break
    case 'unreviewed': where.push('s.star_score = 0'); break
    case 'good': where.push('s.star_score >= 4'); break
    case 'bad': where.push('s.star_score BETWEEN 1 AND 2'); break
    default: {
      const star = int(f.star)
      if (star !== null && star >= 1 && star <= 5) { where.push('s.star_score = ?'); params.push(star) }
    }
  }
  if (f.participate) where.push('m.participate = 1 AND m.active = 1')
  if (f.keyword) {
    where.push('(s.customer_name LIKE ? OR s.session_id = ? OR s.chat_user_id = ?)')
    params.push(`%${f.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, f.keyword, f.keyword)
  }
  switch (f.score) {
    case 'scored': where.push("sc.status = 'ok'"); break
    // 群问题不做质检评分，不算「未评分」
    case 'unscored': where.push("s.source = 'ss' AND (sc.session_id IS NULL OR sc.status <> 'ok')"); break
    case 'failed': where.push("sc.status = 'failed'"); break
  }
  if (f.source) { where.push('s.source = ?'); params.push(f.source) }
  if (f.grade) { where.push("sc.status = 'ok' AND sc.grade = ?"); params.push(f.grade) }
  return { cond: where.length ? ` AND ${where.join(' AND ')}` : '', params }
}

/** 能进批量评分的：在线咨询（群会话不批量评，绩效的 AI 质量只算在线咨询）、参与考核还在项目里的客服、客户发过言、还没评成功过 */
export const BATCH_ELIGIBLE = "s.source = 'ss' AND m.participate = 1 AND m.active = 1 AND s.user_msg_count > 0 AND (sc.session_id IS NULL OR sc.status <> 'ok')"
