import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import {
  API_BASE,
  AUTH_EVENT_NAME,
  clearStoredTokens,
  getStoredAccessToken,
  getStoredRefreshToken,
  getValidAccessToken,
  refreshAccessToken,
  setStoredTokens,
} from '../utils_api'

const AuthContext = createContext(null)

const ROLE_HIERARCHY = { root: 4, tenant_admin: 3, developer: 2, viewer: 1 }

function parseJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch {
    return null
  }
}

function isTokenExpired(token) {
  const payload = parseJwt(token)
  if (!payload?.exp) return true
  return Date.now() >= (payload.exp - 30) * 1000
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => getStoredAccessToken())
  const [refreshToken, setRefreshToken] = useState(() => getStoredRefreshToken())
  const [loading, setLoading] = useState(true)
  const refreshInFlight = useRef(false)

  const saveTokens = useCallback((access, refresh) => {
    setToken(access || null)
    setRefreshToken(refresh || null)
    setStoredTokens(access, refresh)
  }, [])

  const fetchMe = useCallback(async (accessToken) => {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }, [])

  const doRefresh = useCallback(async () => {
    const rt = getStoredRefreshToken()
    if (!rt || refreshInFlight.current) return null
    refreshInFlight.current = true
    try {
      const accessToken = await refreshAccessToken()
      setToken(getStoredAccessToken())
      setRefreshToken(getStoredRefreshToken())
      if (!accessToken) setUser(null)
      return accessToken
    } finally {
      refreshInFlight.current = false
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.detail || `Login failed (${res.status})`)
    }

    const data = await res.json()
    saveTokens(data.access_token, data.refresh_token)

    const me = await fetchMe(data.access_token)
    setUser(me)
    return me
  }, [fetchMe, saveTokens])

  const logout = useCallback(() => {
    clearStoredTokens()
    setToken(null)
    setRefreshToken(null)
    setUser(null)
  }, [])

  const isAuthenticated = useCallback(() => {
    return !!token && !!user
  }, [token, user])

  const hasRole = useCallback((requiredRole) => {
    if (!user?.role) return false
    return (ROLE_HIERARCHY[user.role] || 0) >= (ROLE_HIERARCHY[requiredRole] || 0)
  }, [user])

  const getAccessToken = useCallback(async () => {
    const storedToken = getStoredAccessToken()
    if (storedToken && !isTokenExpired(storedToken)) return storedToken

    const refreshedToken = await getValidAccessToken()
    setToken(getStoredAccessToken())
    setRefreshToken(getStoredRefreshToken())
    return refreshedToken
  }, [])

  useEffect(() => {
    const handleAuthChanged = (event) => {
      const detail = event?.detail || {}
      const nextAccessToken = detail.access_token ?? getStoredAccessToken()
      const nextRefreshToken = detail.refresh_token ?? getStoredRefreshToken()
      setToken(nextAccessToken || null)
      setRefreshToken(nextRefreshToken || null)
      if (!nextAccessToken) setUser(null)
    }

    window.addEventListener(AUTH_EVENT_NAME, handleAuthChanged)
    return () => window.removeEventListener(AUTH_EVENT_NAME, handleAuthChanged)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init() {
      let accessToken = getStoredAccessToken()
      if (!accessToken) {
        setLoading(false)
        return
      }

      if (isTokenExpired(accessToken)) {
        accessToken = await doRefresh()
        if (!accessToken) {
          setLoading(false)
          return
        }
      }

      const me = await fetchMe(accessToken)
      if (cancelled) return

      if (me) {
        setUser(me)
      } else {
        clearStoredTokens('invalid-access-token')
      }
      setLoading(false)
    }

    init()
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    user,
    token,
    loading,
    login,
    logout,
    isAuthenticated,
    hasRole,
    getAccessToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export default useAuth
