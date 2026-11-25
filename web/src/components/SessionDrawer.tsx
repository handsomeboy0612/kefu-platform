import React, { useEffect, useState } from 'react'
import { Button, Collapse, SideSheet, Spin, Toast } from '@douyinfe/semi-ui'
import { api } from '../api'
import { channelName, fmtDuration, GRADE_STYLE, scoreColor, starColor } from '../constants'
import { copyText, fmtTime } from '../utils'
import type { SessionItem } from '../pages/SessionsPage'

interface Message {
  id: number
  senderType: 'customer' | 'staff' | 'bot' | 'system'
  senderName: string
  content: string
  sendTime: number
  imageUrl: string
  recalled: boolean
}

export interface AIScore {
  status: 'ok' | 'failed'
  total: number | null
  grade: string
  dimensions: Array<{ name: string; weight: number; score: number }>
  highlights: string[]
  issues: string[]
  summary: string
  improvement: string
  raw: Record<string, unknown> | null
  error: string
  model: string
  scoredBy: string
  scoredAt: number
  reviewed: boolean
  reviewedBy: string
  reviewedAt: number
}

const pad = (n: number): string => String(n).padStart(2, '0')
const hm = (sec: number): string => {
  const d = new Date(sec * 1000)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const Stars: React.FC<{ v: number }> = ({ v }) => {
  if (!v) return <span className="form-hint" style={{ margin: 0 }}>未评价</span>
  const c = starColor(v)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ letterSpacing: 1 }}>
        {[1, 2, 3, 4, 5].map((i) => <span key={i} style={{ color: i <= v ? c : '#E6DDD2' }}>★</span>)}
      </span>
      <b style={{ color: c }}>{v}</b>
    </span>
  )
}

export const GradePill: React.FC<{ grade: string; reviewed?: boolean }> = ({ grade, reviewed }) => {
  const st = GRADE_STYLE[grade] || GRADE_STYLE['不合格']
  return <span className="pill-tag" style={{ background: st.bg, color: st.color }}>{grade}{reviewed ? ' · 已复核' : ''}</span>
}

/** 提示词里自定义的额外字段（问题清单、回应统计、扣分明细……）原样展示 */
const EXTRA_SKIP = new Set(['各维度得分', '亮点', '问题', '评语', '改进建议', '总分', '评级', 'dimensions', 'total_score', 'grade'])
const ExtraValue: React.FC<{ v: unknown }> = ({ v }) => {
  if (v == null || v === '') return <span className="form-hint" style={{ margin: 0 }}>—</span>
  if (Array.isArray(v)) {
    if (!v.length) return <span className="form-hint" style={{ margin: 0 }}>无</span>
    return <ul className="score-list">{v.map((x, i) => <li key={i}>{typeof x === 'object' ? Object.entries(x as Record<string, unknown>).map(([k, val]) => `${k}：${typeof val === 'object' ? JSON.stringify(val) : String(val)}`).join('；') : String(x)}</li>)}</ul>
  }
  if (typeof v === 'object') return <span>{Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}：${typeof val === 'object' ? JSON.stringify(val) : String(val)}`).join('；')}</span>
  return <span>{String(v)}</span>
}

const ScoreCard: React.FC<{
  score: AIScore | null
  scoring: boolean
  onScore: () => void
  onReview: (v: boolean) => void
}> = ({ score, scoring, onScore, onReview }) => {
  if (!score || score.status !== 'ok') {
    return (
      <div className="score-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="form-label" style={{ flex: 1 }}>
            {score?.status === 'failed' ? <span style={{ color: '#8E3420' }}>上次评分失败：{score.error}</span> : '还没有 AI 评分'}
          </span>
          <Button theme="solid" loading={scoring} onClick={onScore}>{scoring ? '评分中…' : score ? '重试评分' : 'AI 评分'}</Button>
        </div>
      </div>
    )
  }
  const extras = score.raw ? Object.entries(score.raw).filter(([k]) => !EXTRA_SKIP.has(k)) : []
  return (
    <div className="score-card">
      <div className="score-head">
        <span className="score-total" style={{ color: scoreColor(score.total ?? 0) }}>{score.total?.toFixed(1)}</span>
        <GradePill grade={score.grade} reviewed={score.reviewed} />
        <span className="form-hint" style={{ margin: 0, flex: 1 }}>
          {score.model} · {fmtTime(score.scoredAt)} · {score.scoredBy === 'auto' ? '自动评分' : score.scoredBy}
        </span>
        <Button size="small" onClick={() => onReview(!score.reviewed)}>{score.reviewed ? '取消复核' : '标记已复核'}</Button>
        <Button size="small" loading={scoring} onClick={onScore}>{scoring ? '评分中…' : '重新评分'}</Button>
      </div>
      <div className="score-dims">
        {score.dimensions.map((d) => (
          <div key={d.name} className="score-dim">
            <span className="score-dim-name">{d.name}<em>{d.weight}%</em></span>
            <span className="score-dim-bar"><i style={{ width: `${d.score}%`, background: scoreColor(d.score) }} /></span>
            <b style={{ color: scoreColor(d.score) }}>{d.score}</b>
          </div>
        ))}
      </div>
      {score.summary && <div className="score-summary">{score.summary}</div>}
      {!!score.highlights.length && (
        <div className="score-block good"><span>亮点</span><ul className="score-list">{score.highlights.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
      )}
      {!!score.issues.length && (
        <div className="score-block bad"><span>问题</span><ul className="score-list">{score.issues.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
      )}
      {score.improvement && score.improvement !== '无' && (
        <div className="score-block"><span>改进建议</span><div>{score.improvement}</div></div>
      )}
      {!!extras.length && (
        <Collapse style={{ marginTop: 8 }}>
          <Collapse.Panel header="详细分析（提示词里要求的其他内容）" itemKey="extra">
            <div className="stack" style={{ gap: 10 }}>
              {extras.map(([k, v]) => (
                <div key={k} className="score-block"><span>{k}</span><ExtraValue v={v} /></div>
              ))}
            </div>
          </Collapse.Panel>
        </Collapse>
      )}
    </div>
  )
}

/** 会话详情：基本信息 + AI 评分 + 聊天记录 */
const SessionDrawer: React.FC<{
  deptCode: string
  session: SessionItem | null
  onClose: () => void
  onScoreChange?: (sessionId: string, score: AIScore | null) => void
}> = ({ deptCode, session, onClose, onScoreChange }) => {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [score, setScore] = useState<AIScore | null>(null)
  const [error, setError] = useState('')
  const [scoring, setScoring] = useState(false)

  useEffect(() => {
    if (!session) return
    setMessages(null)
    setScore(null)
    setError('')
    api<{ messages: Message[]; score: AIScore | null }>(`/api/sessions/${encodeURIComponent(session.sessionId)}/messages`, { query: { dept: deptCode } })
      .then((d) => { setMessages(d.messages); setScore(d.score) })
      .catch((err) => setError((err as Error).message))
  }, [session, deptCode])

  const copy = async (text: string): Promise<void> => {
    if (await copyText(text)) Toast.success({ content: `已复制：${text}`, duration: 1.5 })
  }

  const doScore = async (): Promise<void> => {
    if (!session) return
    setScoring(true)
    try {
      const s = await api<AIScore>(`/api/sessions/${encodeURIComponent(session.sessionId)}/score`, { body: {}, query: { dept: deptCode } })
      setScore(s)
      onScoreChange?.(session.sessionId, s)
      Toast.success(`评分完成：${s.total} 分（${s.grade}）`)
    } catch (err) {
      Toast.error((err as Error).message)
      setScore((prev) => (prev?.status === 'ok' ? prev : { ...(prev || {} as AIScore), status: 'failed', error: (err as Error).message.replace(/^评分失败：/, '') }))
    } finally {
      setScoring(false)
    }
  }

  const doReview = async (reviewed: boolean): Promise<void> => {
    if (!session) return
    try {
      const s = await api<AIScore>(`/api/sessions/${encodeURIComponent(session.sessionId)}/review`, { body: { reviewed }, query: { dept: deptCode } })
      setScore(s)
      onScoreChange?.(session.sessionId, s)
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }

  return (
    <SideSheet
      title={session ? <span className="copyable-name" onClick={() => copy(session.customerName)}>{session.customerName || '（无客户名）'}</span> : ''}
      visible={!!session}
      onCancel={onClose}
      width={640}
      bodyStyle={{ padding: 0 }}
    >
      {session && (
        <>
          <div className="detail-grid">
            <div><span>接待客服</span><b>{session.memberName || '—'}{!session.participate && <em>（不参与考核）</em>}</b></div>
            <div><span>渠道</span><b>{channelName(session.channel)}</b></div>
            <div><span>开始</span><b>{fmtTime(session.startTime)}</b></div>
            <div><span>时长</span><b>{session.endTime ? fmtDuration(session.endTime - session.startTime) : '—'}</b></div>
            <div><span>满意度</span><b>{session.source === 'wg' ? <span className="form-hint" style={{ margin: 0 }}>群聊无评价</span> : <Stars v={session.starScore} />}</b></div>
            <div><span>消息</span><b>客户 {session.customerMsgCount} · 客服 {session.staffMsgCount}</b></div>
            <div style={{ gridColumn: '1 / -1' }}>
              <span>会话 ID</span>
              <b className="copyable-name" style={{ fontWeight: 400, fontFamily: 'Consolas, monospace', fontSize: 12 }} onClick={() => copy(session.sessionId)}>{session.sessionId}</b>
            </div>
          </div>
          {messages && <ScoreCard score={score} scoring={scoring} onScore={doScore} onReview={doReview} />}
          <div className="chat-container" style={{ height: 'auto', overflow: 'visible' }}>
            {error && <div className="notice error">{error}</div>}
            {!messages && !error && <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}
            {messages && messages.length === 0 && <div className="form-hint" style={{ textAlign: 'center', padding: 40 }}>没有聊天记录</div>}
            {messages?.map((m) => {
              if (m.senderType === 'system') {
                return <div key={m.id} className="chat-system">{m.content} · {hm(m.sendTime)}</div>
              }
              const cls = m.senderType
              return (
                <div key={m.id} className={`chat-bubble ${cls}`}>
                  <div className={`bubble-avatar ${cls}`}>{cls === 'customer' ? '客' : cls === 'bot' ? '机' : (m.senderName || '服').charAt(0)}</div>
                  <div className="bubble-body">
                    <div className="bubble-name-time" style={{ textAlign: cls === 'staff' ? 'right' : 'left' }}>
                      {m.senderName} · {hm(m.sendTime)}{m.recalled ? ' · 已撤回' : ''}
                    </div>
                    <div className={`bubble-text ${cls}`}>
                      {m.imageUrl
                        ? <a href={m.imageUrl} target="_blank" rel="noreferrer"><img src={m.imageUrl} alt="图片" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, display: 'block' }} /></a>
                        : m.content}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </SideSheet>
  )
}

export default SessionDrawer
