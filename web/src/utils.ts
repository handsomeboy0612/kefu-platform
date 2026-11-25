/** 时间、复制等页面通用小工具 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** unix 秒 → 2026-11-24 18:05；0 或空返回 fallback */
export function fmtTime(sec: number | null | undefined, fallback = '—'): string {
  if (!sec) return fallback
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 复制文字。内网用 http 访问时浏览器不给用 navigator.clipboard（只有 https / localhost 才有），
 * 这时退回老办法：临时文本框 + execCommand('copy')。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 走下面的兜底 */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return ok
}
