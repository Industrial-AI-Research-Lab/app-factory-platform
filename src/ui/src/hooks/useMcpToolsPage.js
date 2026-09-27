import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch, formatApiDetail } from '../utils_api'
import { notify } from '../utils_notify'
import { emptyMcpToolForm, groupToolsByServer, hasWhitespace, isMcpTool, mcpCategoryLabel } from '../components/mcp/helpers'
import { partitionServerToolsForDelete } from '../components/mcp/serverToolOwnership'
import { entityDescriptionsForForm, entityDescriptionsForSave } from '../utils/entity_descriptions'
import useMcpCursorJson from './useMcpCursorJson'
import useMcpDiscoverImport from './useMcpDiscoverImport'
import useMcpHealthCheck from './useMcpHealthCheck'
import { formFromServerTools } from '../components/mcp/McpServerSettingsModal'
import { useAuth } from './useAuth'

export default function useMcpToolsPage({ onImportSuccess } = {}) {
  const { user } = useAuth()
  const isRoot = user?.role === 'root'
  const [tools, setTools] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState({})
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyMcpToolForm())
  const [modalError, setModalError] = useState(null)
  const [filter, setFilter] = useState('')
  const [editBaseMetadata, setEditBaseMetadata] = useState(null)
  const [showExternalMcpJson, setShowExternalMcpJson] = useState(true)
  const [serverSettingsGroup, setServerSettingsGroup] = useState(null)
  const [serverSettingsForm, setServerSettingsForm] = useState(null)
  const [serverSettingsError, setServerSettingsError] = useState(null)

  const health = useMcpHealthCheck({ autoCheckOnMount: true })

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/configurations/mcp-tools/')
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || `Failed to load MCP tools (${res.status})`)
      }
      const data = await res.json()
      const list = Array.isArray(data) ? data : []
      setTools(list.filter(isMcpTool))
    } catch (err) {
      setError(err.message)
      notify({ title: 'Failed to load MCP tools', message: err.message, variant: 'error', ttl: 7000 })
    } finally {
      setLoading(false)
    }
  }, [])

  const cursorJson = useMcpCursorJson({ onSaved: fetchAll })

  const discover = useMcpDiscoverImport({
    onToolsChanged: fetchAll,
    cursorJson,
    onImportSuccess,
  })

  const formIdHasSpaces = hasWhitespace(form.id)

  const filtered = useMemo(() => {
    return tools.filter(t => {
      if (!filter) return true
      const q = filter.toLowerCase()
      return (t.name || '').toLowerCase().includes(q) ||
             (t.id || t._id || '').toLowerCase().includes(q) ||
             (t.mcp_server || '').toLowerCase().includes(q)
    })
  }, [tools, filter])

  const groupedByServer = useMemo(() => groupToolsByServer(filtered), [filtered])

  // Shared servers are read-only for tenants (ADR-0013): the backend answers an
  // edit with 409 fork_required, and the confirmed fork copies the whole server.
  // Returns null when the user declines, otherwise the retry's result.
  const confirmForkThen = async (detail, retry) => {
    if (!window.confirm(`${detail.message}\n\nCreate your tenant's copy now?`)) return null
    const res = await apiFetch(
      `/configurations/mcp-tools/mcp-servers/${encodeURIComponent(detail.server_id)}/fork`,
      { method: 'POST' },
    )
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      throw new Error(formatApiDetail(e.detail) || 'Fork failed')
    }
    notify({
      title: 'Server forked',
      message: `Created your copy of "${detail.server_id}" — platform updates no longer apply to it`,
      variant: 'success',
      ttl: 6000,
    })
    return retry()
  }

  const isForkRequired = (detail) =>
    detail && typeof detail === 'object' && detail.code === 'fork_required'

  const toggleEnabled = async (tool) => {
    const id = tool.id || tool._id
    const putToggle = async () => {
      const res = await apiFetch(`/configurations/mcp-tools/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !tool.enabled }),
      })
      return res
    }
    setSaving(prev => ({ ...prev, [id]: true }))
    try {
      const res = await putToggle()
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        if (isForkRequired(e.detail)) {
          await confirmForkThen(e.detail, async () => {
            const r2 = await putToggle()
            if (!r2.ok) {
              const e2 = await r2.json().catch(() => ({}))
              throw new Error(formatApiDetail(e2.detail) || 'Update failed')
            }
            await fetchAll()
          })
          return
        }
        throw new Error(formatApiDetail(e.detail) || 'Update failed')
      }
      const updated = await res.json()
      setTools(prev => prev.map(t => (t.id || t._id) === id ? updated : t))
    } catch (err) {
      notify({ title: 'Toggle failed', message: err.message, variant: 'error', ttl: 6000 })
    } finally {
      setSaving(prev => ({ ...prev, [id]: false }))
    }
  }

  const openEdit = (tool) => {
    const id = tool.id || tool._id
    const ext = (tool.metadata && tool.metadata.external_mcp) || {}
    setEditBaseMetadata(
      tool.metadata && typeof tool.metadata === 'object' ? { ...tool.metadata } : null
    )
    setEditingId(id)
    setForm({
      id,
      name: tool.name || id || '',
      rpc_name: tool.rpc_name || '',
      ...entityDescriptionsForForm(tool),
      category: mcpCategoryLabel(tool.category),
      source: 'mcp_server',
      mcp_server: tool.mcp_server || '',
      enabled: tool.enabled !== false,
      mcp_runtime_scope: ext.runtime_scope === 'tenant' ? 'tenant' : 'project',
      mcp_idle_timeout:
        ext.idle_timeout_seconds != null && ext.idle_timeout_seconds !== ''
          ? String(ext.idle_timeout_seconds)
          : '',
      mcp_on_project_complete: ext.on_project_complete === 'stop_only' ? 'stop_only' : 'remove',
    })
  }

  const closeModal = () => {
    setEditingId(null)
    setEditBaseMetadata(null)
    setModalError(null)
  }

  const saveTool = async () => {
    setModalError(null)
    if (formIdHasSpaces) {
      setModalError({ message: 'Tool ID cannot contain spaces. Use "-" or "_".' })
      return
    }
    const wire = String(form.name || '').trim()
    if (wire) {
      if (wire.length > 64) {
        setModalError({ message: 'Wire name must be at most 64 characters.' })
        return
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(wire)) {
        setModalError({ message: 'Wire name must match [a-zA-Z0-9_-].' })
        return
      }
    }
    const {
      mcp_runtime_scope: _rs,
      mcp_idle_timeout: _idle,
      mcp_on_project_complete: _opc,
      ...formRest
    } = form
    const body = { ...formRest, ...entityDescriptionsForSave(formRest), source: 'mcp_server' }
    if (!body.mcp_server) delete body.mcp_server
    if (!String(body.rpc_name || '').trim()) delete body.rpc_name
    const base = editBaseMetadata && typeof editBaseMetadata === 'object' ? { ...editBaseMetadata } : {}
    const em = { ...(base.external_mcp || {}) }
    em.runtime_scope = _rs || 'project'
    if (_idle !== '' && _idle != null) {
      const n = Number(_idle)
      if (!Number.isNaN(n)) em.idle_timeout_seconds = n
    } else {
      delete em.idle_timeout_seconds
    }
    em.on_project_complete = _opc || 'remove'
    body.metadata = { ...base, external_mcp: em }

    const id = editingId || form.id
    setSaving(prev => ({ ...prev, modal: true }))
    try {
      const { id: _id, ...updateBody } = body
      const res = await apiFetch(`/configurations/mcp-tools/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      })
      if (!res.ok) {
        const e = await res.json()
        const detail = e.detail
        if (detail && typeof detail === 'object' && detail.code === 'name_conflict') {
          setModalError(detail)
          return
        }
        if (isForkRequired(detail)) {
          const done = await confirmForkThen(detail, async () => {
            const r2 = await apiFetch(`/configurations/mcp-tools/${id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updateBody),
            })
            if (!r2.ok) {
              const e2 = await r2.json().catch(() => ({}))
              throw new Error(formatApiDetail(e2.detail) || 'Save failed')
            }
            return true
          })
          if (done) {
            closeModal()
            await fetchAll()
            notify({ title: 'MCP tool updated', message: body.name || id, variant: 'success', ttl: 4000 })
          }
          return
        }
        throw new Error(formatApiDetail(detail) || 'Save failed')
      }
      closeModal()
      await fetchAll()
      notify({ title: 'MCP tool updated', message: body.name || id, variant: 'success', ttl: 4000 })
    } catch (err) {
      setModalError({ message: `Save failed: ${err.message}` })
      notify({ title: 'Save failed', message: err.message, variant: 'error', ttl: 7000 })
    } finally {
      setSaving(prev => ({ ...prev, modal: false }))
    }
  }

  const deleteTool = async (tool) => {
    const id = tool.id || tool._id
    if (!confirm(`Delete MCP tool "${tool.name || id}"?`)) return
    try {
      const res = await apiFetch(`/configurations/mcp-tools/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 204) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Delete failed')
      }
      setTools(prev => prev.filter(t => (t.id || t._id) !== id))
      notify({ title: 'Tool deleted', message: tool.name || id, variant: 'success', ttl: 4000 })
    } catch (err) {
      notify({ title: 'Delete failed', message: err.message, variant: 'error', ttl: 7000 })
    }
  }

  const deleteServer = async (serverId, serverTools) => {
    const sid = String(serverId || '').trim()
    if (!sid || sid === '(no server)' || !serverTools?.length) return
    // Delete only the tenant's own tools; shared __system__ tools 403 and would
    // abort the loop after owned forks were already destroyed (see helper).
    const { owned, shared } = partitionServerToolsForDelete(serverTools)
    if (!owned.length) {
      notify({
        title: 'Nothing to delete',
        message: `"${sid}" is a shared platform server — its tools can't be removed by a tenant.`,
        variant: 'info',
        ttl: 6000,
      })
      return
    }
    const count = owned.length
    const sharedNote = shared.length
      ? ` ${shared.length} shared platform tool(s) will remain — those aren't yours to delete.`
      : ''
    if (
      !window.confirm(
        `Delete MCP server "${sid}" and ${count} installed tool(s)?${sharedNote} Tenant mcp.json will be updated.`
      )
    ) {
      return
    }
    const saveKey = `server:${sid}`
    setSaving(prev => ({ ...prev, [saveKey]: true }))
    try {
      for (const tool of owned) {
        const id = tool.id || tool._id
        const res = await apiFetch(`/configurations/mcp-tools/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok && res.status !== 204) {
          const e = await res.json().catch(() => ({}))
          throw new Error(
            formatApiDetail(e.detail) || `Delete failed for ${tool.name || id}`
          )
        }
      }
      await fetchAll()
      await cursorJson.load()
      notify({
        title: 'Server removed',
        message: `Deleted ${count} tool(s) for "${sid}"`,
        variant: 'success',
        ttl: 5000,
      })
    } catch (err) {
      notify({ title: 'Delete server failed', message: err.message, variant: 'error', ttl: 8000 })
      await fetchAll()
    } finally {
      setSaving(prev => ({ ...prev, [saveKey]: false }))
    }
  }

  const restartServer = async (group) => {
    const sid = String(group?.serverId || '').trim()
    const tenantId = String(group?.tenantId || '').trim()
    if (!sid || !tenantId || !group?.isZipHosted) return
    const saveKey = `server:${group.groupKey}`
    setSaving(prev => ({ ...prev, [saveKey]: true }))
    try {
      const res = await apiFetch(`/configurations/mcp-tools/mcp-servers/${encodeURIComponent(sid)}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Restart failed')
      }
      const result = await res.json()
      await fetchAll()
      notify({
        title: 'Server restarted',
        message: `"${sid}" is ready; ${result.tools_count || 0} tool(s) discovered`,
        variant: 'success',
        ttl: 5000,
      })
    } catch (err) {
      notify({ title: 'Restart server failed', message: err.message, variant: 'error', ttl: 8000 })
      await fetchAll()
    } finally {
      setSaving(prev => ({ ...prev, [saveKey]: false }))
    }
  }

  const deleteMcpServer = async (group) => {
    const sid = String(group?.serverId || '').trim()
    const tenantId = String(group?.tenantId || '').trim()
    if (!sid || sid === '(no server)' || !tenantId || !group?.tools?.length) return
    const extra = group.isZipHosted
      ? ' This also removes the runtime container, ZIP package record, and built Docker image.'
      : ''
    if (!window.confirm(`Delete MCP server "${sid}" in tenant "${tenantId}" and all ${group.tools.length} tool(s)?${extra}`)) return
    const saveKey = `server:${group.groupKey}`
    setSaving(prev => ({ ...prev, [saveKey]: true }))
    try {
      const res = await apiFetch(`/configurations/mcp-tools/mcp-servers/${encodeURIComponent(sid)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Delete failed')
      }
      await fetchAll()
      await cursorJson.load()
      notify({ title: 'Server removed', message: `Deleted "${sid}"`, variant: 'success', ttl: 5000 })
    } catch (err) {
      notify({ title: 'Delete server failed', message: err.message, variant: 'error', ttl: 8000 })
      await fetchAll()
    } finally {
      setSaving(prev => ({ ...prev, [saveKey]: false }))
    }
  }

  const openServerSettings = (group) => {
    const sid = String(group?.serverId || '').trim()
    if (!sid || sid === '(no server)') return
    setServerSettingsError(null)
    setServerSettingsGroup(group)
    setServerSettingsForm(formFromServerTools(group.tools))
  }

  const closeServerSettings = () => {
    setServerSettingsGroup(null)
    setServerSettingsForm(null)
    setServerSettingsError(null)
  }

  const saveServerConnection = async (body) => {
    const group = serverSettingsGroup
    const sid = String(group?.serverId || '').trim()
    if (!sid || !body) return
    const saveKey = `server:${group.groupKey}`
    setServerSettingsError(null)
    setSaving(prev => ({ ...prev, [saveKey]: true }))
    // Shared-group UI may pass tenant_id=__system__. Strip only for non-root so
    // tenant_admin gets fork_required; root keeps __system__ for in-place platform edit.
    const payload = { ...body }
    if (!isRoot && payload.tenant_id === '__system__') delete payload.tenant_id
    try {
      const putOnce = async () => {
        const res = await apiFetch(
          `/configurations/mcp-tools/mcp-servers/${encodeURIComponent(sid)}/connection`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        )
        return res
      }
      let res = await putOnce()
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        if (isForkRequired(e.detail)) {
          // Shared-group form is system-seeded — never apply it onto the fork
          // after catch-up (would wipe tenant credentials). Fork, then stop;
          // user opens Settings on the owned group.
          const fromShared = group.tenantId === '__system__' && !isRoot
          const retryRes = await confirmForkThen(
            e.detail,
            fromShared
              ? async () => ({ ok: true, _forkOnly: true })
              : putOnce,
          )
          if (!retryRes) return
          if (retryRes._forkOnly) {
            await fetchAll()
            await cursorJson.load()
            closeServerSettings()
            notify({
              title: 'Server forked',
              message: `Open Settings on your copy of "${sid}" to change connection`,
              variant: 'success',
              ttl: 7000,
            })
            return
          }
          res = retryRes
        } else {
          throw new Error(formatApiDetail(e.detail) || 'Save failed')
        }
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Save failed')
      }
      const result = await res.json()
      await fetchAll()
      await cursorJson.load()
      closeServerSettings()
      notify({
        title: 'Server settings saved',
        message: `Updated ${result.tools_updated || 0} tool(s) on "${sid}"`,
        variant: 'success',
        ttl: 5000,
      })
    } catch (err) {
      setServerSettingsError(err.message)
      notify({ title: 'Save settings failed', message: err.message, variant: 'error', ttl: 8000 })
    } finally {
      setSaving(prev => ({ ...prev, [saveKey]: false }))
    }
  }

  useEffect(() => { fetchAll() }, [fetchAll])

  return {
    tools,
    loading,
    error,
    saving,
    editingId,
    form,
    setForm,
    modalError,
    filter,
    setFilter,
    groupedByServer,
    filtered,
    showExternalMcpJson,
    setShowExternalMcpJson,
    discoverServerIdHasSpaces: discover.discoverServerIdHasSpaces,
    formIdHasSpaces,
    fetchAll,
    toggleEnabled,
    openEdit,
    closeModal,
    saveTool,
    deleteTool,
    restartServer,
    deleteServer: deleteMcpServer,
    openServerSettings,
    closeServerSettings,
    saveServerConnection,
    serverSettingsGroup,
    serverSettingsForm,
    setServerSettingsForm,
    serverSettingsError,
    clearModalError: () => setModalError(null),
    isRoot,
    health,
    cursorJson,
    discover,
  }
}
