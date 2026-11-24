/**
 * 接口调用：统一 { success, data, error } 格式；未登录时通知外层跳转登录页。
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Listener = () => void
const unauthorizedListeners = new Set<Listener>()

/** 任何接口返回 401 时触发（登录过期、被踢下线） */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  let url = path
  if (init.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }
  const res = await fetch(url, {
    method: init.method || (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  })
  let payload: { success?: boolean; data?: T; error?: string } = {}
  try {
    payload = await res.json()
  } catch {
    // 非 JSON（如服务端没起来时的代理错误页）
  }
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    unauthorizedListeners.forEach((fn) => fn())
  }
  if (!res.ok || payload.success === false) {
    throw new ApiError(res.status, payload.error || `请求失败（HTTP ${res.status}）`)
  }
  return payload.data as T
}
