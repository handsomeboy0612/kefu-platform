import React, { useEffect, useState } from 'react'
import { Button, InputNumber, Input, Popconfirm, Spin, Switch, Toast } from '@douyinfe/semi-ui'
import { IconDelete, IconPlus } from '@douyinfe/semi-icons'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { fmtTime } from '../../utils'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>

type Field =
  | { kind: 'num'; path: string; label: string; unit?: string; step?: number; hint?: string }
  | { kind: 'bool'; path: string; label: string; hint?: string }
  | { kind: 'tiers'; path: string; label: string; hint?: string; cols: Array<{ key: string; label: string; unit?: string; text?: boolean; step?: number }> }

interface Section { title: string; desc?: string; sum?: { paths: string[]; target: number | string }; fields: Field[] }

const get = (o: Obj, path: string): any => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o)
function set(o: Obj, path: string, v: unknown): Obj {
  const keys = path.split('.')
  const out: Obj = Array.isArray(o) ? [...o] as any : { ...o }
  let cur: any = out
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = Array.isArray(cur[keys[i]]) ? [...cur[keys[i]]] : { ...cur[keys[i]] }
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = v
  return out
}

const RESP_TIER = [{ key: 'maxSec', label: '多少秒以内', unit: '秒' }, { key: 'percent', label: '得该项分值的', unit: '%', step: 0.1 }]
const NIGHT_TIER = [{ key: 'maxSec', label: '多少秒以内', unit: '秒' }, { key: 'score', label: '直接得', unit: '分' }]
const GRADES = [{ key: 'label', label: '等级', text: true }, { key: 'min', label: '分数线（≥）', unit: '分' }, { key: 'coeff', label: '绩效系数', step: 0.05 }]
const CLOSURE_POINT = [{ key: 'rate', label: '闭环率达到', unit: '%' }, { key: 'percent', label: '得该项分值的', unit: '%' }]
const BONUS = [{ key: 'ratio', label: '达到团队平均的', unit: '倍', step: 0.1 }, { key: 'extra', label: '额外加', unit: '分' }]

const volume = (base: string, who: string): Field[] => [
  { kind: 'num', path: `${base}.avgPercent`, label: `${who}：刚好等于团队平均时得`, unit: '%' },
  { kind: 'num', path: `${base}.fullRatio`, label: `${who}：达到团队平均几倍得满分`, unit: '倍', step: 0.05 },
  { kind: 'bool', path: `${base}.floorAtAvg`, label: `${who}：低于平均也按平均算（保底）` },
  { kind: 'tiers', path: `${base}.bonusTiers`, label: `${who}：额外加分档（取命中的最高一档）`, cols: BONUS }
]

const CS_SCHEMA: Section[] = [
  {
    title: '五项分数占比', desc: '合计要等于 100；某项填 0 就不考核这一项。',
    sum: { paths: ['weights.sessions', 'weights.replyRate', 'weights.satisfaction', 'weights.response', 'weights.aiQuality'], target: 100 },
    fields: [
      { kind: 'num', path: 'weights.sessions', label: '接待量', unit: '分' },
      { kind: 'num', path: 'weights.replyRate', label: '人工回复率', unit: '分' },
      { kind: 'num', path: 'weights.satisfaction', label: '客户满意度', unit: '分' },
      { kind: 'num', path: 'weights.response', label: '响应速度', unit: '分' },
      { kind: 'num', path: 'weights.aiQuality', label: 'AI 对话质量', unit: '分' }
    ]
  },
  {
    title: '接待量', desc: '按日均接待和团队日均（白班 + 晚班）比：达到平均得满分，不到按比例；通宵班不算接待量。',
    fields: [
      { kind: 'num', path: 'sessions.bonusRatio', label: '日均达到团队平均几倍有额外奖励', unit: '倍', step: 0.05 },
      { kind: 'num', path: 'sessions.bonusExtra', label: '额外奖励', unit: '分' }
    ]
  },
  {
    title: '人工回复率', desc: '客户说过话的会话里，人工回过的比例。',
    fields: [
      { kind: 'num', path: 'replyRate.fullRate', label: '达到多少得满分', unit: '%', step: 0.5 },
      { kind: 'num', path: 'replyRate.midRate', label: '次档线', unit: '%', step: 0.5 },
      { kind: 'num', path: 'replyRate.midPercent', label: '次档得分比例（更低按比例 × 这个比例）', unit: '%' },
      { kind: 'num', path: 'replyGraceSec', label: '秒退宽限：没回且存活不到多少秒的不算', unit: '秒' }
    ]
  },
  {
    title: '客户满意度',
    fields: [
      { kind: 'num', path: 'satisfaction.fullStar', label: '均分达到多少星得满分', unit: '星', step: 0.05 },
      { kind: 'num', path: 'satisfaction.minReviews', label: '评价少于几条按满分（宽限）', unit: '条' },
      { kind: 'num', path: 'satisfaction.passStar', label: '达标展示线（只用于展示）', unit: '星', step: 0.05 }
    ]
  },
  {
    title: '响应速度', desc: '首次响应和平均响应各一套阶梯，两项分值加起来要等于「响应速度」的占比。',
    sum: { paths: ['response.firstScore', 'response.avgScore'], target: 'weights.response' },
    fields: [
      { kind: 'num', path: 'response.firstScore', label: '首次响应分值', unit: '分' },
      { kind: 'tiers', path: 'response.tiers', label: '首次响应阶梯（超出全部档位 0 分）', cols: RESP_TIER },
      { kind: 'num', path: 'response.avgScore', label: '平均响应分值（0 = 不考核）', unit: '分' },
      { kind: 'tiers', path: 'response.avgTiers', label: '平均响应阶梯', cols: RESP_TIER }
    ]
  },
  {
    title: 'AI 对话质量',
    fields: [{ kind: 'num', path: 'aiQuality.fullThreshold', label: 'AI 评分中位数达到多少得满分（不到按比例）', unit: '分' }]
  },
  {
    title: '通宵班专用', desc: '通宵班不算接待量；回复率低于次档直接 0 分；响应阶梯直接给分。',
    fields: [
      { kind: 'num', path: 'night.replyRate.fullRate', label: '回复率满分线', unit: '%', step: 0.5 },
      { kind: 'num', path: 'night.replyRate.midRate', label: '回复率次档线', unit: '%', step: 0.5 },
      { kind: 'num', path: 'night.replyRate.midPercent', label: '次档得分比例', unit: '%' },
      { kind: 'tiers', path: 'night.responseTiers', label: '首次响应阶梯', cols: NIGHT_TIER },
      { kind: 'tiers', path: 'night.avgResponseTiers', label: '平均响应阶梯（空 = 不考核）', cols: NIGHT_TIER }
    ]
  },
  { title: '等级', desc: '综合分从高到低匹配。', fields: [{ kind: 'tiers', path: 'grades', label: '等级线', cols: GRADES }] }
]

const TECH_SCHEMA: Section[] = [
  {
    title: '总分构成', desc: '按《技术支持部绩效考核标准》：第一项 = 网页客服接待（SaleSmartly 在线咨询），第二项 = 对公群技术售后（企业微信对公群里的客户问题）。总 KPI = 第一项 × 占比 + 第二项 × 占比 + 主管评分；三者合计 100。某人只有一项有数据时，按那一项折算。',
    sum: { paths: ['total.part1Weight', 'total.part2Weight', 'total.supervisorMax'], target: 100 },
    fields: [
      { kind: 'num', path: 'total.part1Weight', label: '第一项 · 客服接待', unit: '%' },
      { kind: 'num', path: 'total.part2Weight', label: '第二项 · 对公群技术售后', unit: '%' },
      { kind: 'num', path: 'total.supervisorMax', label: '主管评分满分', unit: '分' },
      { kind: 'num', path: 'total.supervisorDefault', label: '主管评分没录入时按', unit: '分', step: 0.5 },
      { kind: 'bool', path: 'transition', label: '过渡期', hint: 'AI 对话质量没数据时，分值加给接待量 / 满意度 / 响应速度；评价不足的人用团队均分代替' },
      { kind: 'num', path: 'star.partMin', label: '卓越之星：两大项各不低于', unit: '分' },
      { kind: 'num', path: 'star.totalMin', label: '卓越之星：总 KPI 不低于', unit: '分' }
    ]
  },
  {
    title: '第一项（网页客服接待）· 各小项分值', desc: '合计 100。某小项没数据就不计分，按能考核的小项折算成百分制。',
    sum: { paths: ['part1.weights.sessions', 'part1.weights.firstResp', 'part1.weights.avgResp', 'part1.weights.satisfaction', 'part1.weights.aiQuality', 'part1.weights.replyRate'], target: 100 },
    fields: [
      { kind: 'num', path: 'part1.weights.sessions', label: '接待量', unit: '分' },
      { kind: 'num', path: 'part1.weights.firstResp', label: '首次响应', unit: '分' },
      { kind: 'num', path: 'part1.weights.avgResp', label: '平均响应', unit: '分' },
      { kind: 'num', path: 'part1.weights.satisfaction', label: '客户满意度', unit: '分' },
      { kind: 'num', path: 'part1.weights.aiQuality', label: 'AI 对话质量', unit: '分' },
      { kind: 'num', path: 'part1.weights.replyRate', label: '人工回复率', unit: '分' }
    ]
  },
  { title: '第一项（网页客服接待）· 接待量', desc: '和团队平均（白班 + 晚班）比。', fields: [...volume('part1.sessions.dayEvening', '白班 / 晚班'), ...volume('part1.sessions.night', '通宵班')] },
  {
    title: '第一项（网页客服接待）· 响应速度',
    fields: [
      { kind: 'tiers', path: 'part1.firstRespTiers', label: '首次响应阶梯', cols: RESP_TIER },
      { kind: 'tiers', path: 'part1.avgRespTiers', label: '平均响应阶梯', cols: RESP_TIER }
    ]
  },
  {
    title: '第一项（网页客服接待）· 客户满意度', desc: '三点曲线：≥ 满分线满分，= 中间线得中间比例，≤ 零分线 0 分，之间线性。',
    fields: [
      { kind: 'num', path: 'part1.satisfaction.curve.full', label: '满分线', unit: '星', step: 0.05 },
      { kind: 'num', path: 'part1.satisfaction.curve.mid', label: '中间线', unit: '星', step: 0.05 },
      { kind: 'num', path: 'part1.satisfaction.curve.midPercent', label: '中间线得', unit: '%' },
      { kind: 'num', path: 'part1.satisfaction.curve.zero', label: '零分线', unit: '星', step: 0.05 },
      { kind: 'num', path: 'part1.satisfaction.priorCount', label: '平滑：按团队均分补几条（非过渡期）', unit: '条' },
      { kind: 'num', path: 'part1.satisfaction.minReviews', label: '过渡期：评价少于几条用团队均分', unit: '条' }
    ]
  },
  {
    title: '第一项（网页客服接待）· AI 对话质量和人工回复率',
    fields: [
      { kind: 'num', path: 'part1.aiQuality.full', label: 'AI 平均分达到多少得满分', unit: '分' },
      { kind: 'num', path: 'part1.aiQuality.zero', label: 'AI 平均分低于多少得 0', unit: '分' },
      { kind: 'num', path: 'part1.replyRate.curve.full', label: '回复率满分线', unit: '%', step: 0.5 },
      { kind: 'num', path: 'part1.replyRate.curve.mid', label: '回复率中间线', unit: '%', step: 0.5 },
      { kind: 'num', path: 'part1.replyRate.curve.midPercent', label: '中间线得', unit: '%' },
      { kind: 'num', path: 'part1.replyRate.curve.zero', label: '回复率零分线', unit: '%', step: 0.5 },
      { kind: 'num', path: 'part1.replyRate.graceSec', label: '秒退宽限', unit: '秒' }
    ]
  },
  {
    title: '第一项（网页客服接待）· 扣分',
    fields: [
      { kind: 'num', path: 'part1.deduction.complaint', label: '有效投诉每次扣', unit: '分' },
      { kind: 'num', path: 'part1.deduction.unresolvedBad', label: '差评没跟进闭环每次扣', unit: '分' },
      { kind: 'num', path: 'part1.deduction.violation', label: '违规话术 / 泄露信息扣', unit: '分' },
      { kind: 'num', path: 'part1.deduction.cap', label: '每月最多扣', unit: '分' }
    ]
  },
  {
    title: '第二项（对公群技术售后）· 各小项分值', desc: '合计 100。对公群按 AI 整理的客户问题算：一个客户问题算一件，处理人、状态、难度按主管在「群问题」里改过的算。某小项没数据就不计分，按能考核的小项折算。',
    sum: { paths: ['part2.weights.solved', 'part2.weights.firstResp', 'part2.weights.avgResp', 'part2.weights.timeliness', 'part2.weights.closure', 'part2.weights.satisfaction'], target: 100 },
    fields: [
      { kind: 'num', path: 'part2.weights.solved', label: '解决问题数', unit: '分' },
      { kind: 'num', path: 'part2.weights.firstResp', label: '首次响应', unit: '分' },
      { kind: 'num', path: 'part2.weights.avgResp', label: '平均响应', unit: '分' },
      { kind: 'num', path: 'part2.weights.timeliness', label: '处理时效', unit: '分' },
      { kind: 'num', path: 'part2.weights.closure', label: '问题闭环率', unit: '分' },
      { kind: 'num', path: 'part2.weights.satisfaction', label: '客户满意度', unit: '分' }
    ]
  },
  {
    title: '第二项（对公群技术售后）· 解决问题数', desc: '处理人接手的群问题都算（是否解决由闭环率去算），按难度加权后和团队平均比：简单 ×1，一般、疑难按下面的倍数。难度由 AI 判断，主管可在「群问题」里改。跨班交接完整的，交接人和最终处理人各记 0.5 个；交接不完整或没交接，最终处理人记 1 个。问题只算到自己回复处理了的人，或者我方没人回复时被 @ 让他看的人（商务、主管、客户 @ 了支持部的人）；没人回复也没 @ 支持部的人，不算任何人。',
    fields: [
      { kind: 'num', path: 'part2.difficulty.normal', label: '一般问题算几个', unit: '个', step: 0.1 },
      { kind: 'num', path: 'part2.difficulty.hard', label: '疑难问题算几个', unit: '个', step: 0.1 },
      ...volume('part2.solved.dayEvening', '白班 / 晚班'), ...volume('part2.solved.night', '通宵班')
    ]
  },
  {
    title: '第二项（对公群技术售后）· 响应速度', desc: '每个群问题单独打分，最后取平均。首次响应：从商务、主管或客户 @ 处理人让他看开始算；没人 @ 他、他自己接的，从客户这一轮提问开始算（1 分钟内连发的算一条，从最后一条算）→ 处理人第一次回应（「收到，正在看」「稍等」也算，只 @ 同事的派单不算）。平均响应：接手后客户每轮提问到处理人回应的平均；别的同事先回了的那一轮不算，客户只回「好的」「谢谢」不算提问。值班按全天有人算，不扣非值班时间。',
    fields: [
      { kind: 'tiers', path: 'part2.firstRespTiers', label: '首次响应阶梯', cols: RESP_TIER },
      { kind: 'tiers', path: 'part2.avgRespTiers', label: '平均响应阶梯', cols: RESP_TIER }
    ]
  },
  {
    title: '第二项（对公群技术售后）· 处理时效', desc: '每个已解决的问题单独打分再平均。从首次响应到解决：在下面的时间内处理完得满分；超过了，但处理人每隔不超过「同步间隔」就同步一次进度（只回「稍等」「还在看」不算），按比例得分；中间没同步得 0。要靠上游 / 研发才能解决的（AI 判断，主管可在「群问题」里改），按时同步进度得「依赖上游」那一档。3600 秒 = 1 小时。',
    fields: [
      { kind: 'num', path: 'part2.timeliness.fullSec', label: '多久内处理完得满分', unit: '秒' },
      { kind: 'num', path: 'part2.timeliness.syncSec', label: '超时后，每隔多久至少同步一次进度', unit: '秒' },
      { kind: 'num', path: 'part2.timeliness.syncedPercent', label: '超时但按时同步了进度，得', unit: '%' },
      { kind: 'num', path: 'part2.timeliness.upstreamPercent', label: '依赖上游 / 研发、自己解决不了，但按时同步了进度，得', unit: '%' }
    ]
  },
  {
    title: '第二项（对公群技术售后）· 问题闭环率', desc: '闭环率 = 各问题计分之和 ÷ 问题数：自己解决算 1（客户确认，或 24 小时内没再追问）；没解决但交接了，按下面的计分（交接人那一份按交接情况算；AI 判断，主管可在「群问题」里改）；没解决、没交接算 0。判断不了的问题主管确认前不算。闭环率在两点之间线性折算，低于最后一点得最后一点的分。',
    fields: [
      { kind: 'num', path: 'part2.closureRule.handedFull', label: '没解决但交接完整，算', unit: '个', step: 0.1 },
      { kind: 'num', path: 'part2.closureRule.handedPart', label: '有交接但不完整，算', unit: '个', step: 0.1 },
      { kind: 'tiers', path: 'part2.closureRule.points', label: '闭环率计分点', cols: CLOSURE_POINT }
    ]
  },
  {
    title: '第二项（对公群技术售后）· 客户满意度和扣分', desc: '满意度起评满分，按投诉、抱怨逐次扣：群里 AI 标出、判断能归到本人的直接计入（主管可在「群问题」里改），加上「绩效考核 → 录入」里手填的群外的。扣分项里，晾着客户由程序按消息时间算（客户说话后超过 1 / 2 小时没有任何员工回应），交接遗漏按 AI 判出的「没交接」扣在交接人；给错信息、违规话术人工录入。',
    fields: [
      { kind: 'num', path: 'part2.satisfaction.complaint', label: '有效投诉每次扣', unit: '分' },
      { kind: 'num', path: 'part2.satisfaction.mild', label: '轻度抱怨每次扣', unit: '分' },
      { kind: 'num', path: 'part2.satisfaction.praise', label: '点名表扬每次加', unit: '分' },
      { kind: 'num', path: 'part2.satisfaction.praiseCap', label: '表扬每月最多加', unit: '分' },
      { kind: 'num', path: 'part2.deduction.ignored1h', label: '晾着客户超过 1 小时每次扣', unit: '分' },
      { kind: 'num', path: 'part2.deduction.ignored2h', label: '超过 2 小时或因此被投诉每次扣', unit: '分' },
      { kind: 'num', path: 'part2.deduction.handoverMiss', label: '交接遗漏每次扣', unit: '分' },
      { kind: 'num', path: 'part2.deduction.wrongInfo', label: '给错信息造成损失每次扣', unit: '分' },
      { kind: 'num', path: 'part2.deduction.violation', label: '违规话术 / 泄露信息扣', unit: '分' },
      { kind: 'num', path: 'part2.deduction.cap', label: '每月最多扣', unit: '分' }
    ]
  },
  { title: '等级', desc: '第一项、第二项通用；S 另需当月没有有效投诉，违规当月不能评 S / A。', fields: [{ kind: 'tiers', path: 'grades', label: '等级线', cols: GRADES }] }
]

interface RulesResp { rules: Obj; isDefault: boolean; updatedAt: number; updatedBy: string; template: 'cs' | 'tech'; defaults: Obj }

/** 设置 → 考核规则：按部门模板（客服部 / 技术支持部）生成表单 */
const KpiRulesTab: React.FC = () => {
  const { dept } = useAuth()
  const [data, setData] = useState<RulesResp | null>(null)
  const [rules, setRules] = useState<Obj | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!dept) return
    api<RulesResp>('/api/kpi/rules', { query: { dept: dept.code } })
      .then((d) => { setData(d); setRules(d.rules) })
      .catch((err) => Toast.error((err as Error).message))
  }, [dept])

  if (!dept) return null
  if (!data || !rules) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>

  const schema = data.template === 'tech' ? TECH_SCHEMA : CS_SCHEMA
  const dirty = JSON.stringify(rules) !== JSON.stringify(data.rules)
  const upd = (path: string, v: unknown): void => setRules((r) => (r ? set(r, path, v) : r))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const d = await api<RulesResp>('/api/kpi/rules', { method: 'PUT', body: rules, query: { dept: dept.code } })
      setData(d)
      setRules(d.rules)
      Toast.success('考核规则已保存，重新生成报表后生效')
    } catch (err) {
      Toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const reset = async (): Promise<void> => {
    try {
      const d = await api<RulesResp>('/api/kpi/rules/reset', { body: {}, query: { dept: dept.code } })
      setData(d)
      setRules(d.rules)
      Toast.success('已恢复默认规则')
    } catch (err) {
      Toast.error((err as Error).message)
    }
  }

  const renderField = (f: Field): React.ReactNode => {
    if (f.kind === 'num') {
      return (
        <div key={f.path} className="rule-row">
          <span>{f.label}{f.hint && <em>{f.hint}</em>}</span>
          <InputNumber value={get(rules, f.path)} step={f.step ?? 1} onChange={(v) => upd(f.path, v === '' ? 0 : Number(v))} suffix={f.unit} style={{ width: 140 }} />
        </div>
      )
    }
    if (f.kind === 'bool') {
      return (
        <div key={f.path} className="rule-row">
          <span>{f.label}{f.hint && <em>{f.hint}</em>}</span>
          <Switch checked={!!get(rules, f.path)} onChange={(v) => upd(f.path, v)} />
        </div>
      )
    }
    const list: Obj[] = get(rules, f.path) || []
    return (
      <div key={f.path} className="rule-tiers">
        <div className="rule-tiers-title">{f.label}</div>
        {list.map((row, i) => (
          <div key={i} className="rule-tier-row">
            {f.cols.map((c) => c.text
              ? <Input key={c.key} value={row[c.key]} onChange={(v) => upd(f.path, list.map((x, j) => (j === i ? { ...x, [c.key]: v } : x)))} prefix={c.label} style={{ width: 150 }} />
              : <InputNumber key={c.key} value={row[c.key]} step={c.step ?? 1} prefix={c.label} suffix={c.unit}
                  onChange={(v) => upd(f.path, list.map((x, j) => (j === i ? { ...x, [c.key]: v === '' ? 0 : Number(v) } : x)))} style={{ width: 220 }} />)}
            <Button icon={<IconDelete />} theme="borderless" type="tertiary" onClick={() => upd(f.path, list.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button icon={<IconPlus />} theme="borderless" size="small"
          onClick={() => upd(f.path, [...list, Object.fromEntries(f.cols.map((c) => [c.key, c.text ? '' : 0]))])}>加一档</Button>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="notice" style={{ marginTop: 0 }}>
        {data.template === 'tech' ? '技术支持部绩效考核标准（2026-11-11）' : '客服部考核规则'}，默认值和原桌面版一样。
        改了只影响本部门，保存后重新生成报表才生效；已经生成的历史报表按当时的规则存着，不会变。
      </div>
      {schema.map((sec) => {
        let sumInfo: React.ReactNode = null
        if (sec.sum) {
          const sum = Math.round(sec.sum.paths.reduce((s, p) => s + (Number(get(rules, p)) || 0), 0) * 100) / 100
          const target = typeof sec.sum.target === 'number' ? sec.sum.target : Number(get(rules, sec.sum.target)) || 0
          sumInfo = <span className={`pill-tag ${Math.abs(sum - target) < 0.01 ? 'success' : 'danger'}`}>合计 {sum} / {target}</span>
        }
        return (
          <div key={sec.title} className="panel">
            <div className="panel-head">
              <div className="panel-title" style={{ margin: 0 }}>{sec.title}</div>
              {sumInfo}
            </div>
            {sec.desc && <div className="panel-desc">{sec.desc}</div>}
            <div className="rule-fields">{sec.fields.map(renderField)}</div>
          </div>
        )
      })}
      <div className="form-actions" style={{ marginTop: 0 }}>
        <Button theme="solid" loading={saving} disabled={!dirty} onClick={() => void save()}>保存</Button>
        <Button disabled={!dirty} onClick={() => setRules(data.rules)}>撤销改动</Button>
        <Popconfirm title="恢复默认规则？" content="会删掉本部门改过的规则，恢复成和原桌面版一样的默认值。" onConfirm={() => void reset()}>
          <Button type="danger" disabled={data.isDefault}>恢复默认</Button>
        </Popconfirm>
        <span className="footnote" style={{ marginLeft: 'auto' }}>
          {data.isDefault ? '现在用的是默认规则' : `最近修改：${fmtTime(data.updatedAt)} · ${data.updatedBy}`}
        </span>
      </div>
    </div>
  )
}

export default KpiRulesTab
