import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch, formatApiDetail } from '../utils_api'
import { notify } from '../utils_notify'
import {
  diffMcpServersJson,
  parseMcpServersObject,
  sanitizeMcpServersForSave,
} from '../utils/mcpJsonHelpers'

export default function useMcpCursorJson({ onSaved } = {}) {
  const [raw, setRaw] = useState('')
  const [baselineRaw, setBaselineRaw] = useState('')
  const [parseRaw, setParseRaw] = useState('')
  const [error, setError] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [saveDiff, setSaveDiff] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/configurations/mcp-tools/mcp-servers/cursor-json')
      if (!res.ok) {
        const e = await res.json()
        throw new Error(formatApiDetail(e.detail) || 'Load cursor json failed')
      }
      const data = await res.json()
      const txt = data.cursor_json || '{\n  "mcpServers": {}\n}'
      setRaw(txt)
      setBaselineRaw(txt)
      setParseRaw('')
      setWarnings([])
      setSaveDiff(null)
      setError(null)
    } catch (e) {
      const msg = e.message || String(e)
      setError(msg)
      notify({ title: 'Failed to load mcp.json', message: msg, variant: 'error', ttl: 7000 })
    }
  }, [])

  const savePreview = useMemo(() => {
    const { error: diffErr, preview } = diffMcpServersJson(baselineRaw, raw)
    if (diffErr) return { error: diffErr, preview: null }
    return { error: null, preview }
  }, [baselineRaw, raw])

  const saveTenantCursorJson = useCallback(async (text) => {
    const parsed = parseMcpServersObject(text)
    if (parsed.error) {
      throw new Error(parsed.error)
    }
    const { mcpServers, warnings: sanitizeWarnings, errors, sanitizedText } = sanitizeMcpServersForSave(
      parsed.mcpServers
    )
    if (errors.length) {
      throw new Error(errors.join(' '))
    }
    const payloadText = sanitizedText || text
    const payload = { cursor_json: payloadText }
    const res = await apiFetch('/configurations/mcp-tools/mcp-servers/cursor-json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const e = await res.json()
      throw new Error(formatApiDetail(e.detail) || 'Save cursor json failed')
    }
    const data = await res.json()
    const next = data.cursor_json || payloadText
    setRaw(next)
    setBaselineRaw(next)
    setSaveDiff(data.import_diff || null)
    const allWarnings = [...sanitizeWarnings, ...(data.warnings || [])]
    setWarnings(allWarnings)
    return { next, import_diff: data.import_diff, warnings: allWarnings }
  }, [])

  const saveFromEditor = useCallback(async () => {
    const preview = savePreview?.preview
    const removedCount = preview?.removed_servers?.length || 0
    const isDestructiveClear =
      !(raw || '').trim()
      || removedCount > 0
    if (isDestructiveClear) {
      const msg = !(raw || '').trim()
        ? 'Empty mcp.json will remove ALL MCP tools for this tenant. Continue?'
        : `This will remove ${removedCount} MCP server(s) and all their tools. Continue?`
      if (!window.confirm(msg)) {
        return
      }
    }
    setSaving(true)
    setError(null)
    setWarnings([])
    try {
      const { import_diff, warnings: w } = await saveTenantCursorJson(raw)
      const added = import_diff?.added_servers?.length || 0
      const removed = import_diff?.removed_servers?.length || 0
      const unchanged = import_diff?.unchanged_servers?.length || 0
      let msg = `Unchanged: ${unchanged} server(s)`
      if (added) msg += `, import: ${added} new`
      if (removed) msg += `, removed: ${removed}`
      notify({
        title: 'Tenant mcp.json saved',
        message: msg,
        variant: 'success',
        ttl: 6000,
      })
      if (w?.length) {
        notify({
          title: 'mcp.json name fixes',
          message: w.slice(0, 2).join(' ') + (w.length > 2 ? ` (+${w.length - 2} more)` : ''),
          variant: 'warning',
          ttl: 9000,
        })
      }
      onSaved?.()
    } catch (e) {
      const msg = e.message || String(e)
      setError(msg)
      notify({ title: 'Save failed', message: msg, variant: 'error', ttl: 7000 })
    } finally {
      setSaving(false)
    }
  }, [raw, savePreview, saveTenantCursorJson, onSaved])

  useEffect(() => { load() }, [load])

  return {
    raw,
    setRaw,
    baselineRaw,
    parseRaw,
    setParseRaw,
    error,
    setError,
    warnings,
    saveDiff,
    savePreview,
    saving,
    load,
    saveTenantCursorJson,
    saveFromEditor,
  }
}
