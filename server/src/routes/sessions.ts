/**
 * 会话记录接口：列表（筛选 + 分页）、筛选项、单个会话的聊天记录和 AI 评分。
 * 部门只能看到负责客服在本部门的会话。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError, resolveDepartment, type Department } from '../auth'
import { query } from '../db'
import { deptProjectId } from '../members'
import { getDeptSetting } from '../settings'
import { describeFetchError, SalesmartlyClient } from '../services/salesmartly'
import { fetchSessionMessages } from '../sync/salesmartly-sync'
import { filterSql, parseFilter, SESSION_FROM } from '../sessions-filter'
import { getScore, scoreView } from '../ai/service'

interface SessionDbRow {
  session_id: string
  source: string
  chat_user_id: string
  customer_name: string
  sys_user_id: number
  channel: number
  start_time: number
  end_time: number
  assign_time: number
  star_score: number
  msg_count: number
  user_msg_count: number
  kf_msg_count: number
  msgs_synced: number
  nickname: string
  participate: number
  active: number
  sc_status: string | null
  sc_total: string | number | null
  sc_grade: string | null
  sc_reviewed: number | null
  issue_id: number
  issue_status: string
  issue_summary: string
}

const toView = (r: SessionDbRow): Record<string, unknown> => ({
  sessionId: r.session_id,
  source: r.source,
  chatUserId: r.chat_user_id,
  customerName: r.customer_name,
  sysUserId: Number(r.sys_user_id),
  memberName: r.nickname,
  /** 负责客服这时是否参与考核（不参与的会话照样显示，只是不算进看板和绩效） */
  participate: !!r.participate && !!r.active,
  channel: r.channel,
  startTime: Number(r.start_time),
  endTime: Number(r.end_time),
  assignTime: Number(r.assign_time),
  starScore: r.star_score,
  msgCount: r.msg_count,
  customerMsgCount: r.user_msg_count,
  staffMsgCount: r.kf_msg_count,
  msgsSynced: !!r.msgs_synced,
  /** AI 评分：none 没评过 / ok / failed */
  scoreStatus: r.sc_status || 'none',
  aiTotal: r.sc_total == null ? null : Number(r.sc_total),
  aiGrade: r.sc_grade || '',
  aiReviewed: !!r.sc_reviewed,
  /** 对公群（source = 'wg'）：AI 整理的群问题编号、状态（按主管改过的）、摘要 */
  issueId: Number(r.issue_id || 0),
  issueStatus: r.issue_status || '',
  issueSummary: r.issue_summary || ''
})

const SELECT = `
  SELECT s.session_id, s.source, s.chat_user_id, s.customer_name, s.sys_user_id, s.channel, s.start_time, s.end_time, s.assign_time,
         s.star_score, s.msg_count, s.user_msg_count, s.kf_msg_count, s.msgs_synced, m.nickname, m.participate, m.active,
         sc.status sc_status, sc.total_score sc_total, sc.grade sc_grade, sc.reviewed sc_reviewed, s.issue_id, s.issue_status, s.issue_summary`

export async function deptScope(req: FastifyRequest): Promise<{ dept: Department; projectId: string }> {
  const dept = await resolveDepartment(req, (req.query as { dept?: string }).dept)
  return { dept, projectId: await deptProjectId(dept) }
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sessions', async (req) => {
    const { dept, projectId } = await deptScope(req)
    const q = req.query as Record<string, string | undefined>
    const page = Math.max(1, Math.trunc(Number(q.page)) || 1)
    const pageSize = Math.min(200, Math.max(10, Math.trunc(Number(q.pageSize)) || 20))
    if (!projectId) return { success: true, data: { list: [], total: 0, page, pageSize, summary: { reviewed: 0, bad: 0, avgStar: 0, aiScored: 0, aiAvg: 0 } } }

    const { cond, params } = filterSql(parseFilter(q))
    const base = [dept.id, projectId, ...params]
    const [cnt] = await query<{ total: number; reviewed: number; star_sum: number; bad: number; ai_scored: number; ai_sum: number }>(
      `SELECT COUNT(*) total, SUM(s.star_score > 0) reviewed, SUM(s.star_score) star_sum, SUM(s.star_score BETWEEN 1 AND 2) bad,
              SUM(sc.status = 'ok') ai_scored, SUM(IF(sc.status = 'ok', sc.total_score, 0)) ai_sum
       ${SESSION_FROM}${cond}`,
      base
    )
    const rows = await query<SessionDbRow>(
      `${SELECT} ${SESSION_FROM}${cond} ORDER BY s.start_time DESC LIMIT ? OFFSET ?`,
      [...base, pageSize, (page - 1) * pageSize]
    )
    const reviewed = Number(cnt?.reviewed || 0)
    const aiScored = Number(cnt?.ai_scored || 0)
    return {
      success: true,
      data: {
        list: rows.map(toView),
        total: Number(cnt?.total || 0),
        page,
        pageSize,
        summary: {
          reviewed,
          bad: Number(cnt?.bad || 0),
          avgStar: reviewed ? Math.round((Number(cnt?.star_sum || 0) / reviewed) * 100) / 100 : 0,
          aiScored,
          aiAvg: aiScored ? Math.round((Number(cnt?.ai_sum || 0) / aiScored) * 10) / 10 : 0
        }
      }
    }
  })

  /** 筛选项：本部门客服、出现过的渠道 */
  app.get('/api/sessions/filters', async (req) => {
    const { dept, projectId } = await deptScope(req)
    if (!projectId) return { success: true, data: { members: [], channels: [] } }
    const members = await query<{ sys_user_id: number; nickname: string; participate: number; active: number }>(
      'SELECT sys_user_id, nickname, participate, active FROM members WHERE project_id = ? AND department_id = ? ORDER BY active DESC, nickname',
      [projectId, dept.id]
    )
    const channels = await query<{ channel: number }>(
      `SELECT DISTINCT s.channel FROM ss_sessions s
       JOIN members m ON m.project_id = s.project_id AND m.sys_user_id = s.sys_user_id AND m.department_id = ?
       WHERE s.project_id = ? AND s.source <> 'wgr' ORDER BY s.channel`,
      [dept.id, projectId]
    )
    return {
      success: true,
      data: {
        members: members.map((m) => ({ sysUserId: Number(m.sys_user_id), nickname: m.nickname, participate: !!m.participate && !!m.active })),
        channels: channels.map((c) => c.channel)
      }
    }
  })

  /** 一个会话的详情、聊天记录和 AI 评分。还没拉过聊天记录的，当场从 SaleSmartly 拉 */
  app.get('/api/sessions/:sessionId/messages', async (req) => {
    const { dept, projectId } = await deptScope(req)
    const sessionId = (req.params as { sessionId: string }).sessionId
    const [row] = await query<SessionDbRow>(`${SELECT} ${SESSION_FROM} AND s.session_id = ?`, [dept.id, projectId, sessionId])
    if (!row) throw new HttpError(404, '会话不存在，或不是本部门客服接待的')

    if (!row.msgs_synced) {
      try {
        await fetchSessionMessages(new SalesmartlyClient(await getDeptSetting(dept.code, 'salesmartly')), projectId, sessionId)
      } catch (err) {
        throw new HttpError(502, `从 SaleSmartly 拉聊天记录失败：${describeFetchError(err)}`)
      }
    }
    const messages = await query<{
      id: number; sender_type: string; sender_name: string; content: string; msg_type: number; send_time: number; image_url: string; recalled: number
    }>(
      `SELECT id, sender_type, sender_name, content, msg_type, send_time, image_url, recalled
       FROM ss_messages WHERE project_id = ? AND session_id = ? ORDER BY send_time, id`,
      [projectId, sessionId]
    )
    const score = await getScore(projectId, sessionId)
    return {
      success: true,
      data: {
        session: { ...toView(row), msgsSynced: true },
        score: score ? scoreView(score) : null,
        messages: messages.map((m) => ({
          id: m.id,
          senderType: m.sender_type,
          senderName: m.sender_name,
          content: m.content,
          msgType: m.msg_type,
          sendTime: Number(m.send_time),
          imageUrl: m.image_url,
          recalled: !!m.recalled
        }))
      }
    }
  })
}
