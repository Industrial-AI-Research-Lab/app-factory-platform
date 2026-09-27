import { createContext, useContext, useState, useEffect, useCallback } from 'react'
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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => getStoredAccessToken())
  const [refreshToken, setRefreshToken] = useState(() => getStoredRefreshToken())
  const [loading, setLoading] = useState(true)

  const syncTokenState = useCallback(() => {
    setToken(getStoredAccessToken())
    setRefreshToken(getStoredRefreshToken())
  }, [])

  const saveTokens = useCallback((access, refresh) => {
    setStoredTokens(access, refresh)
    setToken(access || null)
    setRefreshToken(refresh || null)
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
    try {
      const accessToken = await refreshAccessToken()
      syncTokenState()
      return accessToken
    } catch {
      clearStoredTokens('refresh-failed')
      syncTokenState()
      setUser(null)
      return null
    }
  }, [syncTokenState])

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
    clearStoredTokens('logout')
    syncTokenState()
    setUser(null)
  }, [syncTokenState])

  const isAuthenticated = useCallback(() => {
    return !!token && !!user
  }, [token, user])

  const hasRole = useCallback((requiredRole) => {
    if (!user?.role) return false
    return (ROLE_HIERARCHY[user.role] || 0) >= (ROLE_HIERARCHY[requiredRole] || 0)
  }, [user])

  const getAccessToken = useCallback(async () => {
    const accessToken = await getValidAccessToken()
    syncTokenState()
    return accessToken
  }, [syncTokenState])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleAuthUpdated = () => {
      syncTokenState()
    }

    window.addEventListener(AUTH_EVENT_NAME, handleAuthUpdated)
    return () => window.removeEventListener(AUTH_EVENT_NAME, handleAuthUpdated)
  }, [syncTokenState])

  useEffect(() => {
    let cancelled = false

    async function init() {
      let accessToken = await getValidAccessToken()
      syncTokenState()

      if (!accessToken) {
        setLoading(false)
        return
      }

      // One retry after explicit refresh to handle edge case with stale cached token.
      let me = await fetchMe(accessToken)
      if (!me) {
        accessToken = await doRefresh()
        if (accessToken) {
          me = await fetchMe(accessToken)
        }
      }

      if (cancelled) return

      if (me) {
        setUser(me)
      } else {
        clearStoredTokens('invalid-access-token')
        syncTokenState()
        setUser(null)
      }

      setLoading(false)
    }

    init()
    return () => {
      cancelled = true
    }
  }, [doRefresh, fetchMe, syncTokenState])

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
