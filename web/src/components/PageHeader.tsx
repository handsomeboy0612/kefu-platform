import React from 'react'

interface Props {
  /** 大标题（宋体） */
  title: string
  /** 标题下一句话说明这个页面是干什么的 */
  desc?: React.ReactNode
  /** 口径标签，例如「技术支持部」 */
  scope?: React.ReactNode
  /** 口径标签后面的补充说明 */
  scopeHint?: React.ReactNode
  /** 右侧：最近同步时间之类的状态 */
  extra?: React.ReactNode
  /** 页头下方、右侧状态左边的控件（日期区间等） */
  children?: React.ReactNode
}

/** 每个页面统一的页头：大号宋体标题 + 一句说明 + 口径标签 + 右侧状态 */
const PageHeader: React.FC<Props> = ({ title, desc, scope, scopeHint, extra, children }) => (
  <div>
    <h1 className="page-title">{title}</h1>
    {desc && <div className="page-desc">{desc}</div>}
    {(scope || scopeHint) && (
      <div className="page-scope">
        {scope && <span className="pill-tag">{scope}</span>}
        {scopeHint && <span>{scopeHint}</span>}
      </div>
    )}
    {(children || extra) && (
      <div className="page-header" style={{ marginTop: 16 }}>
        <div>{children}</div>
        {extra && <div className="page-meta">{extra}</div>}
      </div>
    )}
  </div>
)

export default PageHeader
