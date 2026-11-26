import React from 'react'
import { Button, Table, Tooltip } from '@douyinfe/semi-ui'
import { fmtSec, KpiGrade, pct, type KpiItem, type TechResult } from './types'
import type { ExemptTarget } from './ExemptModal'

const P1_NAMES: Record<string, string> = { sessions: '接待量', firstResp: '首次响应', avgResp: '平均响应', satisfaction: '客户满意度', aiQuality: 'AI 对话质量', replyRate: '人工回复率' }
const P2_NAMES: Record<string, string> = { solved: '解决问题数', firstResp: '首次响应', avgResp: '平均响应', timeliness: '处理时效', closure: '问题闭环率', satisfaction: '客户满意度' }

const Items: React.FC<{ items: Record<string, KpiItem>; names: Record<string, string> }> = ({ items, names }) => (
  <div className="kpi-items">
    {Object.entries(items).map(([k, it]) => (
      <span key={k} className={it.score === null ? 'na' : ''}>
        {names[k]} <b>{it.score === null ? '不计' : it.score}</b>/{it.full}
      </span>
    ))}
  </div>
)

/** 技术支持部结果表：第一项 · 客服接待、第二项 · 对公群、主管评分 → 总 KPI */
const TechTable: React.FC<{
  results: TechResult[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rules: any
  onExempt?: (t: ExemptTarget) => void
  onManual?: (r: TechResult) => void
}> = ({ results, rules, onExempt, onManual }) => {
  const T = rules.total
  const columns = [
    { title: '#', key: 'rank', width: 48, render: (_: unknown, __: unknown, i: number) => <span className="kpi-rank">{i + 1}</span> },
    {
      title: '客服', dataIndex: 'name', width: 140,
      render: (v: string, r: TechResult) => (
        <div>
          <b style={{ fontWeight: 600 }}>{v}</b>
          {r.star && <span className="pill-tag success" style={{ marginLeft: 6 }}>卓越之星</span>}
          <div className="kpi-cell-sub">{r.shiftLabel}</div>
        </div>
      )
    },
    {
      title: `第一项 · 客服接待 ${T.part1Weight}%`, key: 'p1',
      render: (_: unknown, r: TechResult) => {
        const p = r.p1
        if (!p) return <span className="form-hint" style={{ margin: 0 }}>本期没有网页接待，不考核</span>
        return (
          <div className="kpi-part">
            <div className="kpi-part-head">
              <b className="kpi-total" style={{ fontSize: 18 }}>{p.score}</b>
              <KpiGrade grade={p.grade} coeff={p.coeff} />
              {p.transitionApplied && <Tooltip content="AI 对话质量没有数据，按过渡期把它的分值加给接待量 / 满意度 / 响应速度"><span className="pill-tag muted">过渡期</span></Tooltip>}
              {(p.bonus > 0 || p.deduction > 0) && <span className="kpi-cell-sub">{p.bonus ? `加 ${p.bonus}` : ''}{p.deduction ? ` 扣 ${p.deduction}` : ''}</span>}
            </div>
            <div className="kpi-cell-sub">
              接待 {p.sessionCnt}（团队 {p.teamAvgCnt}）· {p.respNoData ? '没有回复记录' : `首响 ${fmtSec(p.avgResponseSec)} 均响 ${fmtSec(p.avgReplySec)}`} ·{' '}
              <a className="copyable-name" onClick={() => onExempt?.({ kind: 'bad_review', sysUserId: r.sysUserId, name: r.name })}>
                {p.avgStar < 0 ? '无评价' : `${p.avgStar} 星 ${p.scoredCnt} 条`}{p.usedStar != null && p.usedStar !== p.avgStar ? `（按 ${p.usedStar} 算）` : ''}
              </a>{' '}·{' '}
              <a className="copyable-name" onClick={() => onExempt?.({ kind: 'reply', sysUserId: r.sysUserId, name: r.name })}>回复率 {pct(p.replyRate)}</a>
              {p.aiAvgScore != null ? ` · AI ${p.aiAvgScore}（${p.aiScoredCount} 个）` : ''}
            </div>
            <Items items={p.items} names={P1_NAMES} />
          </div>
        )
      }
    },
    {
      title: `第二项 · 对公群 ${T.part2Weight}%`, key: 'p2', width: 300,
      render: (_: unknown, r: TechResult) => {
        const p = r.p2
        if (!p) return <span className="form-hint" style={{ margin: 0 }}>本期没有处理对公群问题，不考核（总分按第一项折算）</span>
        return (
          <div className="kpi-part">
            <div className="kpi-part-head"><b className="kpi-total" style={{ fontSize: 18 }}>{p.score}</b><KpiGrade grade={p.grade} coeff={p.coeff} /></div>
            {p.source === 'ai'
              ? <div className="kpi-cell-sub">
                  群问题 {p.threadCnt}{p.weightedCnt != null && p.weightedCnt !== p.threadCnt ? `（难度加权 ${p.weightedCnt}）` : ''}，{p.roomCnt} 个群，团队 {p.teamAvgCnt} · 首响 {fmtSec(p.avgFirstSec)} 均响 {fmtSec(p.avgReplySec)}<br />
                  解决 {p.resolvedCnt} · 未解决 {p.unresolvedCnt}{p.handedCnt ? ` · 交接 ${p.handedCnt}` : ''} · 判断不了 {p.unknownCnt} · 闭环 {p.closureRate == null ? '—' : `${p.closureRate}%`}
                  {p.avgResolveSec != null ? ` · 平均处理 ${fmtSec(p.avgResolveSec)}` : ''}
                </div>
              : <div className="kpi-cell-sub">群会话 {p.threadCnt}（{p.roomCnt} 个群，团队 {p.teamAvgCnt}，按规则切段）· 首响 {fmtSec(p.avgFirstSec)}</div>}
            <Items items={p.items} names={P2_NAMES} />
          </div>
        )
      }
    },
    {
      title: `主管评分 ${T.supervisorMax}`, key: 'sup', width: 120,
      render: (_: unknown, r: TechResult) => (
        <div>
          <Tooltip content={r.supervisorNote || (r.supervisorDefaulted ? `还没录入，按默认 ${T.supervisorDefault} 分` : '没写评语')}>
            <b style={{ color: r.supervisorDefaulted ? 'var(--app-text-3)' : 'var(--app-text-1)' }}>{r.supervisorScore}{r.supervisorDefaulted ? ' 默认' : ''}</b>
          </Tooltip>
          {onManual && <div><Button size="small" theme="borderless" onClick={() => onManual(r)}>录入</Button></div>}
        </div>
      )
    },
    { title: '总 KPI', dataIndex: 'finalScore', width: 90, render: (v: number) => <b className="kpi-total">{v}</b> }
  ]
  return <Table rowKey="sysUserId" columns={columns} dataSource={results} pagination={false} size="middle" />
}

export default TechTable
