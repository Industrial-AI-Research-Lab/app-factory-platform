// Centralized API base + auth helpers for dev/prod
const RAW = (import.meta?.env?.VITE_API_BASE || '/api').replace(/\/$/, '')

const TOKEN_REFRESH_SKEW_SECONDS = 30
export const AUTH_EVENT_NAME = 'AppFactory:auth-updated'

// Ensure the base ends with '/api' when using a full domain; leave '/api' as-is in dev
function ensureApiSuffix(base) {
  try {
    if (base === '/api') return base
    if (/\/api$/i.test(base)) return base
    if (/^https?:\/\//i.test(base)) return `${base}/api`
    return base
  } catch {
    return base
  }
}

export const API_BASE = ensureApiSuffix(RAW)

/** Normalize FastAPI ``detail`` (string or structured object) for toasts. */
export function formatApiDetail(detail) {
  if (detail == null) return 'Request failed'
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object') {
    // Structured rejections ship the actionable part in errors[], not
    // message ("Invalid workflow DAG" vs which node is wrong) — keep both.
    const errs = Array.isArray(detail.errors)
      ? detail.errors.filter(Boolean).map(String).join('; ')
      : ''
    const conflicts = Array.isArray(detail.conflicts)
      ? detail.conflicts
          .map((c) => {
            if (c == null || typeof c !== 'object') return String(c)
            const who = c.name || c.id || ''
            const why = c.reason || ''
            return [who, why].filter(Boolean).join(': ')
          })
          .filter(Boolean)
          .join('; ')
      : ''
    const extras = [errs, conflicts].filter(Boolean).join('; ')
    if (detail.message) return extras ? `${detail.message}: ${extras}` : detail.message
    // Attachment create fail: {error, project_id} — toast the error, not the whole object.
    if (detail.error != null && detail.error !== '') {
      const errText = typeof detail.error === 'string' ? detail.error : formatApiDetail(detail.error)
      return extras ? `${errText}: ${extras}` : errText
    }
    if (extras) return extras
    return JSON.stringify(detail)
  }
  return String(detail)
}

/** Recovery handle from structured create/upload errors (R2: project kept). */
export function projectIdFromApiDetail(detail) {
  if (!detail || typeof detail !== 'object') return null
  const id = detail.project_id
  if (id == null || id === '') return null
  return String(id)
}

let refreshPromise = null

export function apiUrl(path) {
  if (!path) return API_BASE
  if (/^https?:\/\//i.test(path)) return path
  const p = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${p}`
}

function getStorage() {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

function dispatchAuthEvent(accessToken, refreshToken, reason = 'updated') {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(
    new CustomEvent(AUTH_EVENT_NAME, {
      detail: {
        access_token: accessToken || null,
        refresh_token: refreshToken || null,
        reason,
      },
    })
  )
}

export function getStoredAccessToken() {
  const storage = getStorage()
  if (!storage) return null
  // Backward compatibility: old key `token`
  return storage.getItem('access_token') || storage.getItem('token')
}

export function getStoredRefreshToken() {
  const storage = getStorage()
  if (!storage) return null
  return storage.getItem('refresh_token')
}

export function setStoredTokens(accessToken, refreshToken, reason = 'updated') {
  const storage = getStorage()
  if (!storage) return

  if (accessToken) {
    storage.setItem('access_token', accessToken)
    storage.setItem('token', accessToken)
  } else {
    storage.removeItem('access_token')
    storage.removeItem('token')
  }

  if (refreshToken) {
    storage.setItem('refresh_token', refreshToken)
  } else {
    storage.removeItem('refresh_token')
  }

  dispatchAuthEvent(accessToken, refreshToken, reason)
}

export function clearStoredTokens(reason = 'cleared') {
  setStoredTokens(null, null, reason)
}

function withAuth(options = {}, tokenOverride = null) {
  const { headers: rawHeaders, ...rest } = options || {}
  const headers = new Headers(rawHeaders || {})

  const token = tokenOverride || getStoredAccessToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return { ...rest, headers }
}

function shouldRefresh(url) {
  return !url.includes('/auth/login') && !url.includes('/auth/refresh')
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    if (typeof atob === 'function') {
      return JSON.parse(atob(base64))
    }

    if (typeof Buffer !== 'undefined') {
      return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    }

    return null
  } catch {
    return null
  }
}

function isTokenExpiringSoon(token, skewSeconds = TOKEN_REFRESH_SKEW_SECONDS) {
  const payload = decodeJwtPayload(token)
  if (!payload?.exp) return false
  return Date.now() >= (Number(payload.exp) - skewSeconds) * 1000
}

async function requestRefresh(refreshToken) {
  const response = await fetch(apiUrl('/auth/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!response.ok) {
    throw new Error(`Refresh failed (${response.status})`)
  }

  const payload = await response.json()
  if (!payload?.access_token) {
    throw new Error('Refresh response missing access token')
  }

  const nextRefreshToken = payload.refresh_token || refreshToken
  setStoredTokens(payload.access_token, nextRefreshToken, 'refreshed')

  return payload.access_token
}

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise

  const refreshToken = getStoredRefreshToken()
  if (!refreshToken) {
    throw new Error('Missing refresh token')
  }

  refreshPromise = requestRefresh(refreshToken).finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

export async function getValidAccessToken() {
  const currentToken = getStoredAccessToken()
  if (!currentToken) return null

  if (!isTokenExpiringSoon(currentToken)) {
    return currentToken
  }

  try {
    return await refreshAccessToken()
  } catch {
    return null
  }
}

function redirectToLogin() {
  if (typeof window === 'undefined') return
  if (window.location?.pathname === '/login') return
  window.location.href = '/login'
}

export async function apiFetch(path, options = {}) {
  const url = apiUrl(path)

  // Preemptive refresh to avoid mid-request expiry.
  if (shouldRefresh(url)) {
    const currentToken = getStoredAccessToken()
    const hasRefreshToken = Boolean(getStoredRefreshToken())
    if (currentToken && hasRefreshToken && isTokenExpiringSoon(currentToken)) {
      try {
        await refreshAccessToken()
      } catch {
        // Continue with current token; 401 path below will handle final auth outcome.
      }
    }
  }

  const response = await fetch(url, withAuth(options))

  if (response.status !== 401 || !shouldRefresh(url)) {
    return response
  }

  if (!getStoredRefreshToken()) {
    clearStoredTokens('missing-refresh-token')
    redirectToLogin()
    return response
  }

  try {
    const accessToken = await refreshAccessToken()
    const retried = await fetch(url, withAuth(options, accessToken))

    if (retried.status === 401) {
      clearStoredTokens('unauthorized-after-refresh')
      redirectToLogin()
    }

    return retried
  } catch (err) {
    // Only AbortError skips logout; signal.aborted alone can hide a real refresh failure.
    if (err?.name === 'AbortError') {
      throw err
    }
    clearStoredTokens('refresh-failed')
    redirectToLogin()
    return response
  }
}

/** apiFetch + JSON body, raising the API `detail` so callers can toast it. */
export async function apiJson(path, options) {
  const res = await apiFetch(path, options)
  if (!res.ok) {
    let detail = `Server error (${res.status})`
    try {
      const body = await res.json()
      detail = formatApiDetail(body?.detail) || detail
    } catch {
      /* body may be empty or non-JSON */
    }
    throw new Error(detail)
  }
  return res.json()
}

/**
 * Mint a short-TTL download URL via API (JSON {url}).
 * Paths must be without /api prefix (apiUrl adds VITE_API_BASE), e.g.
 * `/projects/{id}/attachments/{aid}` — same pattern as archive download-url.
 */
export async function presignedDownloadUrl(path) {
  if (!path) throw new Error('Missing download path')
  const data = await apiJson(path)
  const url = data?.url
  if (!url || typeof url !== 'string') {
    throw new Error('Download URL missing from API response')
  }
  return url
}

export async function openPresignedDownload(path) {
  window.open(await presignedDownloadUrl(path), '_blank', 'noopener,noreferrer')
}
