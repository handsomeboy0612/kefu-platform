import React from 'react'
import ReactDOM from 'react-dom/client'
import { semiGlobal } from '@douyinfe/semi-ui'
import App from './App'
import '@douyinfe/semi-ui/dist/css/semi.min.css'
import './styles/global.css'

// React 19 移除了 ReactDOM.render，Semi 的 Toast / Modal.confirm 等命令式组件需注入 createRoot 才能渲染
semiGlobal.config.createRoot = ReactDOM.createRoot

/** 根级错误边界：渲染异常时显示错误详情而非整页白屏 */
class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[RootErrorBoundary]', error.message, '\n', error.stack, '\n组件栈:', info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.7 }}>
          <h2 style={{ color: '#EC1313' }}>页面出错了</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f5f6f7', padding: 12, borderRadius: 6, maxHeight: 400, overflow: 'auto' }}>
            {this.state.error.stack}
          </pre>
          <button onClick={() => window.location.reload()} style={{ padding: '6px 16px', cursor: 'pointer' }}>重新加载</button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)
