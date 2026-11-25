import React from 'react'
import { Table, Tooltip } from '@douyinfe/semi-ui'
import { fmtSec, KpiGrade, pct, type CsResult } from './types'
import type { ExemptTarget } from './ExemptModal'

const Cell: React.FC<{ score: number; full: number; sub: React.ReactNode; tip?: string; onClick?: () => void }> = ({ score, full, sub, tip, onClick }) => {
  const body = (
    <div className={onClick ? 'kpi-cell clickable' : 'kpi-cell'} onClick={onClick}>
      <b>{score}</b><span>/{full}</span>
      <div className="kpi-cell-sub">{sub}</div>
    </div>
  )
  return tip ? <Tooltip content={tip}>{body}</Tooltip> : body
}

/** 客服部结果表：接待量 / 回复率 / 满意度 / 响应 / AI 质量 → 综合分、等级 */
const CsTable: React.FC<{
  results: CsResult[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rules: any
  onExempt?: (t: ExemptTarget) => void
}> = ({ results, rules, onExempt }) => {
  const W = rules.weights
  // 通宵班响应满分 = 首响阶梯最高分 + 均响阶梯最高分
  const maxScore = (tiers: Array<{ score: number }> | undefined): number => Math.max(0, ...(tiers || []).map((t) => t.score))
  const nightRespFull = maxScore(rules.night?.responseTiers) + maxScore(rules.night?.avgResponseTiers)
  const columns = [
    { title: '#', key: 'rank', width: 48, render: (_: unknown, __: unknown, i: number) => <span className="kpi-rank">{i + 1}</span> },
    {
      title: '客服', dataIndex: 'name', width: 130,
      render: (v: string, r: CsResult) => <div><b style={{ fontWeight: 600 }}>{v}</b><div className="kpi-cell-sub">{r.shiftLabel}</div></div>
    },
    {
      title: `接待量 ${W.sessions}`, key: 'sessions', width: 130,
      render: (_: unknown, r: CsResult) => r.isNight
        ? <div className="kpi-cell"><span className="form-hint" style={{ margin: 0 }}>通宵班不计</span><div className="kpi-cell-sub">{r.sessionCnt} 个</div></div>
        : <Cell score={r.sessionScore} full={W.sessions} sub={`日均 ${r.dailyAvgCnt}（团队 ${r.teamAvgCnt}）`}
          tip={`接待 ${r.sessionCnt} 个，出勤 ${r.activeDays} 天，日均 ${r.dailyAvgCnt}；团队日均（白班 + 晚班）${r.teamAvgCnt}`} />
    },
    {
      title: `回复率 ${W.replyRate}`, key: 'reply', width: 130,
      render: (_: unknown, r: CsResult) => (
        <Cell score={r.replyScore} full={W.replyRate} sub={`${pct(r.replyRate)}（${r.replyNum}/${r.replyDen}）`}
          tip={`客户说过话的会话里人工回过的比例${r.replyGraced ? `；秒退 / 剔除 ${r.replyGraced} 个不算` : ''}。点开看没回的会话`}
          onClick={onExempt ? () => onExempt({ kind: 'reply', sysUserId: r.sysUserId, name: r.name }) : undefined} />
      )
    },
    {
      title: `满意度 ${W.satisfaction}`, key: 'sat', width: 140,
      render: (_: unknown, r: CsResult) => (
        <Cell score={r.satisfyScore} full={W.satisfaction}
          sub={r.avgStar < 0 ? '无评价（宽限满分）' : `${r.avgStar} 星 · ${r.scoredCnt} 条${r.graceApplied ? ' · 宽限' : ''}${r.badReviewDeducted ? ` · 剔除 ${r.badReviewDeducted}` : ''}`}
          tip={`评价不足 ${rules.satisfaction.minReviews} 条按宽限给满分；均分 ≥ ${rules.satisfaction.fullStar} 满分。点开看评价明细、申诉剔除差评`}
          onClick={onExempt ? () => onExempt({ kind: 'bad_review', sysUserId: r.sysUserId, name: r.name }) : undefined} />
      )
    },
    {
      title: `响应速度 ${W.response}`, key: 'resp', width: 130,
      render: (_: unknown, r: CsResult) => (
        <Cell score={r.responseScore} full={r.isNight ? nightRespFull : W.response}
          sub={r.respNoData ? '没有回复记录' : `首响 ${fmtSec(r.avgResponseSec)} · 均响 ${fmtSec(r.avgReplySec)}`}
          tip={r.isNight ? '通宵班按专用阶梯直接给分（接待量并入响应速度）' : `首次响应 ${r.firstRespScore} + 平均响应 ${r.avgRespScore}`} />
      )
    },
    {
      title: `AI 质量 ${W.aiQuality}`, key: 'ai', width: 130,
      render: (_: unknown, r: CsResult) => (
        <Cell score={r.aiComponent} full={W.aiQuality}
          sub={r.aiAvgScore == null ? <span style={{ color: '#9C3B26' }}>没有 AI 评分，记 0</span> : `中位数 ${r.aiAvgScore} · ${r.aiScoredCount} 个`}
          tip={`AI 质检中位数 ≥ ${rules.aiQuality.fullThreshold} 满分，否则按比例；评分覆盖 ${pct(r.aiCoverage)}`} />
      )
    },
    {
      title: '综合分', dataIndex: 'finalScore', width: 90,
      render: (v: number) => <b className="kpi-total">{v}</b>
    },
    { title: '等级', dataIndex: 'grade', width: 80, render: (v: string, r: CsResult) => <KpiGrade grade={v} coeff={r.coeff} /> }
  ]
  return <Table rowKey="sysUserId" columns={columns} dataSource={results} pagination={false} size="middle" />
}

export default CsTable
