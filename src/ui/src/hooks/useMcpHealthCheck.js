import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../utils_api'
import { notify } from '../utils_notify'
import { mergeHealthResult } from '../components/mcp/healthMerge'

const AUTO_CHECK_DEBOUNCE_MS = 500
// Client ceiling: backend HEALTH_CHECK_WALL_CLOCK_S (35) + network margin.
const HEALTH_CHECK_CLIENT_TIMEOUT_MS = 45_000

export default function useMcpHealthCheck({ autoCheckOnMount = true } = {}) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [panelDismissed, setPanelDismissed] = useState(true)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const ranAutoCheck = useRef(false)
  const abortRef = useRef(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (abortRef.current) {
        abortRef.current.abort()
      }
    }
  }, [])

  const runHealthCheck = useCallback(async ({ silent = false, serverIds, tenantId } = {}) => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_CLIENT_TIMEOUT_MS)
    const isActive = () => aliveRef.current && abortRef.current === controller
    const ids = Array.isArray(serverIds)
      ? [...new Set(serverIds.map((s) => String(s || '').trim()).filter(Boolean))]
      : null

    setLoading(true)
    setError(null)
    if (!silent) {
      setPanelDismissed(false)
      setPanelCollapsed(false)
    }
    try {
      const fetchOpts = {
        method: 'POST',
        signal: controller.signal,
      }
      if (ids || tenantId) {
        fetchOpts.headers = { 'Content-Type': 'application/json' }
        fetchOpts.body = JSON.stringify({ server_ids: ids, tenant_id: tenantId || undefined })
      }
      const res = await apiFetch('/configurations/mcp-tools/mcp-servers/health-check', fetchOpts)
      if (!isActive()) return
      if (!res.ok) {
        let detail = res.statusText
        try {
          const e = await res.json()
          detail = e.detail || detail
        } catch (_) { /* ignore */ }
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
      }
      const data = await res.json()
      if (!isActive()) return
      setError(null)
      setResult((prev) => mergeHealthResult(prev, data, ids))
      if (!silent) {
        const errN = data.summary_error ?? 0
        const okN = data.summary_ok ?? 0
        const skipN = data.summary_skipped ?? 0
        const polN = data.summary_policy_blocked ?? 0
        const nfN = data.summary_not_found ?? 0
        const parts = [`${okN} ok`, `${errN} error(s)`]
        if (skipN > 0) parts.push(`${skipN} skipped`)
        if (polN > 0) parts.push(`${polN} allowlist`)
        if (nfN > 0) parts.push(`${nfN} not found`)
        notify({
          title: ids ? 'MCP health check (selected)' : 'MCP health check',
          message: parts.join(', '),
          variant: errN > 0 || skipN > 0 || polN > 0 || nfN > 0 ? 'warning' : 'success',
          ttl: 5000,
        })
      }
    } catch (err) {
      // Superseded by a newer run (or unmount): ignore AbortError / late errors.
      if (!isActive()) return
      if (err?.name === 'AbortError') {
        const msg = 'Health check timed out or was cancelled'
        setError(msg)
        if (!ids) setResult(null)
        if (!silent) {
          notify({ title: 'MCP health check failed', message: msg, variant: 'error', ttl: 8000 })
        }
        return
      }
      const msg = err.message || String(err)
      setError(msg)
      if (!ids) setResult(null)
      if (!silent) {
        notify({ title: 'MCP health check failed', message: msg, variant: 'error', ttl: 8000 })
      }
    } finally {
      clearTimeout(timeoutId)
      // Only the active run clears loading / ownership; superseded runs must not touch state.
      if (abortRef.current === controller) {
        abortRef.current = null
        if (aliveRef.current) {
          setLoading(false)
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!autoCheckOnMount || ranAutoCheck.current) return
    ranAutoCheck.current = true
    const t = setTimeout(() => {
      runHealthCheck({ silent: true })
    }, AUTO_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [autoCheckOnMount, runHealthCheck])

  const dismissPanel = useCallback(() => {
    setPanelDismissed(true)
  }, [])

  return {
    loading,
    result,
    error,
    panelDismissed,
    panelCollapsed,
    setPanelCollapsed,
    runHealthCheck,
    dismissPanel,
  }
}
