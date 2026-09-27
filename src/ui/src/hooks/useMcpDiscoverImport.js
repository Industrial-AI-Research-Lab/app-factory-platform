import { useEffect, useState } from 'react'
import { apiFetch, formatApiDetail } from '../utils_api'
import {
  cursorEntryToDiscoverForm,
  parseCursorMcpServersJson,
} from '../utils/mcp_cursor_preset'
import { notify } from '../utils_notify'
import {
  emptyDiscoverForm,
  hasWhitespace,
  parseCmdArgs,
  parseEnvVars,
  upsertServerIntoCursorJsonText,
} from '../components/mcp/helpers'

export default function useMcpDiscoverImport({
  onToolsChanged,
  cursorJson,
  onImportSuccess,
}) {
  const {
    raw: mcpPresetRaw,
    baselineRaw,
    setError: setMcpPresetError,
    saveTenantCursorJson,
  } = cursorJson

  const [discovering, setDiscovering] = useState(false)
  const [discoverForm, setDiscoverForm] = useState(emptyDiscoverForm)
  const [discoveredTools, setDiscoveredTools] = useState([])
  const [selectedDiscovered, setSelectedDiscovered] = useState({})
  const [lastDiscoveredCheckedIdx, setLastDiscoveredCheckedIdx] = useState(null)
  const [showDiscovery, setShowDiscovery] = useState(true)
  const [mcpParseRaw, setMcpParseRaw] = useState('')
  const [mcpPresetEntries, setMcpPresetEntries] = useState(null)
  const [mcpPresetSelectedKey, setMcpPresetSelectedKey] = useState('')
  const [mcpPresetWarnings, setMcpPresetWarnings] = useState([])
  const [mcpPresetNpxDockerImage, setMcpPresetNpxDockerImage] = useState('')
  const [discoveryConnectMode, setDiscoveryConnectMode] = useState('remote')
  const [importSaving, setImportSaving] = useState(false)

  const discoverServerIdHasSpaces = hasWhitespace(discoverForm.server_id)

  const mcpPresetDockerOptions = () => ({
    runNpxInDocker: true,
    npxRunnerImage: mcpPresetNpxDockerImage.trim() || undefined,
  })

  const applyCursorPresetForKey = (key, entry) => {
    setMcpPresetError(null)
    try {
      const { form: df, warnings } = cursorEntryToDiscoverForm(key, entry, mcpPresetDockerOptions())
      setDiscoverForm(df)
      setDiscoveryConnectMode(df.mode === 'stdio' ? 'docker' : 'remote')
      setMcpPresetWarnings(warnings)
      setDiscoveredTools([])
      setSelectedDiscovered({})
    } catch (e) {
      setMcpPresetError(e.message || String(e))
      setMcpPresetWarnings([])
    }
  }

  useEffect(() => {
    if (!mcpPresetEntries?.length || !mcpPresetSelectedKey) return
    const found = mcpPresetEntries.find(([k]) => k === mcpPresetSelectedKey)
    if (!found) return
    try {
      const { form: df, warnings } = cursorEntryToDiscoverForm(found[0], found[1], {
        runNpxInDocker: true,
        npxRunnerImage: mcpPresetNpxDockerImage.trim() || undefined,
      })
      setDiscoverForm(df)
      setMcpPresetWarnings(warnings)
      setMcpPresetError(null)
    } catch (e) {
      setMcpPresetError(e.message || String(e))
    }
  }, [mcpPresetNpxDockerImage, mcpPresetEntries, mcpPresetSelectedKey, setMcpPresetError])

  useEffect(() => {
    setDiscoverForm((f) => {
      if (discoveryConnectMode === 'docker') return f
      if (discoveryConnectMode === 'remote') {
        return f.mode === 'stdio' ? { ...f, mode: 'http' } : f
      }
      return f
    })
  }, [discoveryConnectMode])

  const parseCursorPresetJson = () => {
    setMcpPresetError(null)
    setMcpPresetWarnings([])
    try {
      const { entries } = parseCursorMcpServersJson(mcpParseRaw.trim() || '{}')
      setMcpPresetEntries(entries)
      const firstKey = entries[0][0]
      setMcpPresetSelectedKey(firstKey)
      applyCursorPresetForKey(firstKey, entries[0][1])
      notify({ title: 'JSON parsed', message: `${entries.length} server(s) loaded into form`, variant: 'success', ttl: 4000 })
    } catch (e) {
      setMcpPresetEntries(null)
      setMcpPresetSelectedKey('')
      const msg = e.message || String(e)
      setMcpPresetError(msg)
      notify({ title: 'Parse failed', message: msg, variant: 'error', ttl: 7000 })
    }
  }

  const onMcpPresetServerChange = (key) => {
    setMcpPresetSelectedKey(key)
    if (!mcpPresetEntries) return
    const found = mcpPresetEntries.find(([k]) => k === key)
    if (found) applyCursorPresetForKey(found[0], found[1])
  }

  const buildDiscoverApiPayload = (f, connectMode) => {
    const isHttp = f.mode === 'http' || f.mode === 'streamable-http'
    const requireEndpoint = connectMode === 'remote'
    const validHeaders = f.headers.filter(h => h.name.trim())
    return {
      server_id: f.server_id.trim(),
      endpoint: requireEndpoint ? f.endpoint.trim() : '',
      mode: f.mode,
      timeout_seconds: Number(f.timeout_seconds) || 30,
      headers: validHeaders.length ? validHeaders : null,
      image: f.image.trim() || null,
      docker_env_vars: parseEnvVars(f.docker_env_vars_raw),
      docker_cmd_args: parseCmdArgs(f.docker_cmd_args_raw),
      command: f.command.trim() || null,
      command_args: parseCmdArgs(f.command_args_raw),
      command_env: parseEnvVars(f.command_env_raw),
      container_port: connectMode === 'docker' ? (Number(f.container_port) || 8080) : null,
      endpoint_path: connectMode === 'docker' ? ((f.path || '/mcp').trim() || '/mcp') : null,
    }
  }

  const runDiscoverRequest = async (f, connectMode) => {
    const isHttp = f.mode === 'http' || f.mode === 'streamable-http'
    if (connectMode === 'remote' && isHttp && !f.endpoint.trim()) {
      throw new Error('Remote HTTP mode needs a connection URL')
    }
    const payload = buildDiscoverApiPayload(f, connectMode)
    const res = await apiFetch('/configurations/mcp-tools/mcp-servers/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      throw new Error(formatApiDetail(e.detail) || 'Discovery failed')
    }
    const data = await res.json()
    return data.tools || []
  }

  const discoverExternalTools = async () => {
    const f = discoverForm
    if (!f.server_id.trim()) {
      notify({ title: 'Server ID required', message: 'Enter a server identifier before discover', variant: 'warning', ttl: 5000 })
      return
    }
    if (hasWhitespace(f.server_id)) {
      notify({ title: 'Invalid server ID', message: 'Server ID cannot contain spaces', variant: 'warning', ttl: 5000 })
      return
    }

    setDiscovering(true)
    try {
      const list = await runDiscoverRequest(f, discoveryConnectMode)
      setDiscoveredTools(list)
      const initial = {}
      for (const t of list) initial[t.name] = true
      setSelectedDiscovered(initial)
      notify({
        title: 'Discovery complete',
        message: `Found ${list.length} tool(s) on server "${f.server_id.trim()}"`,
        variant: 'success',
        ttl: 5000,
      })
    } catch (err) {
      notify({ title: 'Discovery failed', message: err.message || String(err), variant: 'error', ttl: 8000 })
    } finally {
      setDiscovering(false)
    }
  }

  const buildDiscoverFormFromZipPayload = (zipPayload, imageTag) => {
    const img = String(imageTag || zipPayload?.image || '').trim()
    const mode = zipPayload?.mode || 'streamable-http'
    const serverId = String(zipPayload?.server_id || '').trim()
    if (!serverId || hasWhitespace(serverId)) {
      return null
    }
    return {
      ...emptyDiscoverForm(),
      server_id: serverId,
      mode,
      image: img,
      container_port: Number(zipPayload?.container_port) || 8080,
      path: zipPayload?.path || '/mcp',
      endpoint: '',
      timeout_seconds: 120,
      mcp_runtime_scope: zipPayload?.runtime_scope || 'tenant',
      mcp_source: 'zip',
    }
  }

  const resetZipDiscoverSession = () => {
    setDiscoverForm(emptyDiscoverForm())
    setDiscoveredTools([])
    setSelectedDiscovered({})
    setLastDiscoveredCheckedIdx(null)
    setDiscoveryConnectMode('remote')
  }

  const applyZipPackageToDiscoverForm = (zipPayload, imageTag) => {
    const formSnapshot = buildDiscoverFormFromZipPayload(zipPayload, imageTag)
    if (!formSnapshot) {
      resetZipDiscoverSession()
      return null
    }
    setDiscoverForm(formSnapshot)
    setDiscoveryConnectMode('docker')
    setDiscoveredTools([])
    setSelectedDiscovered({})
    return formSnapshot
  }

  const discoverAfterZipImport = async (zipPayload, imageTag) => {
    const serverId = String(zipPayload?.server_id || '').trim()
    if (!serverId) {
      notify({ title: 'Server ID required', variant: 'warning', ttl: 4000 })
      return
    }
    if (hasWhitespace(serverId)) {
      notify({ title: 'Invalid server ID', message: 'Server ID cannot contain spaces', variant: 'warning', ttl: 5000 })
      return
    }
    const formSnapshot = applyZipPackageToDiscoverForm(zipPayload, imageTag)
    if (!formSnapshot) return

    setDiscovering(true)
    try {
      const list = await runDiscoverRequest(formSnapshot, 'docker')
      setDiscoveredTools(list)
      const initial = {}
      for (const t of list) initial[t.name] = true
      setSelectedDiscovered(initial)
      notify({
        title: 'Tools discovered',
        message: `${list.length} tool(s) from built image — select and import below`,
        variant: 'success',
        ttl: 5000,
      })
    } catch (err) {
      notify({ title: 'Discovery failed', message: err.message || String(err), variant: 'error', ttl: 8000 })
    } finally {
      setDiscovering(false)
    }
  }

  const importDiscoveredTools = async () => {
    const chosen = discoveredTools.filter(t => selectedDiscovered[t.name])
    if (chosen.length === 0) {
      notify({ title: 'Nothing selected', message: 'Select at least one discovered tool to import', variant: 'warning', ttl: 5000 })
      return
    }
    if ((mcpPresetRaw || '') !== (baselineRaw || '')) {
      const proceed = window.confirm(
        'mcp.json editor has unsaved changes. Import merges into the saved tenant config, not your current edits. Continue?'
      )
      if (!proceed) return
    }
    setImportSaving(true)
    try {
      const serverId = discoverForm.server_id.trim()
      const metadata = {
        external_mcp: {
          endpoint: discoverForm.endpoint.trim(),
          mode: discoverForm.mode,
          container_port: Number(discoverForm.container_port) || 8080,
          path: (discoverForm.path || '/mcp').trim() || '/mcp',
          headers: discoverForm.headers.filter(h => h.name.trim()),
          image: discoverForm.image.trim() || null,
          docker_env_vars: parseEnvVars(discoverForm.docker_env_vars_raw),
          docker_cmd_args: parseCmdArgs(discoverForm.docker_cmd_args_raw),
          command: discoverForm.command.trim() || null,
          command_args: parseCmdArgs(discoverForm.command_args_raw),
          command_env: parseEnvVars(discoverForm.command_env_raw),
          timeout_seconds: Number(discoverForm.timeout_seconds) || 30,
          ...(discoveryConnectMode === 'docker' && discoverForm.mcp_source === 'zip'
            ? { source: 'zip', recover_on_startup: true }
            : {}),
          ...(discoveryConnectMode === 'docker'
            ? {
                runtime_scope: discoverForm.mcp_runtime_scope || 'project',
                on_project_complete: discoverForm.mcp_on_project_complete || 'remove',
                ...(discoverForm.mcp_idle_timeout !== '' && discoverForm.mcp_idle_timeout != null
                  ? (() => {
                      const n = Number(discoverForm.mcp_idle_timeout)
                      return Number.isNaN(n) ? {} : { idle_timeout_seconds: n }
                    })()
                  : {}),
              }
            : {}),
        },
      }
      const tools = chosen.map((t) => ({
        id: `${serverId}.${t.name}`.replace(/\s+/g, '_').toLowerCase(),
        name: t.name,
        description: t.description || '',
        schema: t.schema || null,
      }))
      const res = await apiFetch('/configurations/mcp-tools/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mcp_server: serverId,
          metadata,
          tools,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Batch create failed')
      }
      const created = await res.json()
      const importedCount = created.created_count ?? chosen.length
      await onToolsChanged()

      // Tools are already committed by batch; cursor.json is best-effort UX sync
      // (backend also syncs from tools). Do not treat cursor failure as import failure.
      let cursorError = null
      try {
        const mergedCursorJson = upsertServerIntoCursorJsonText(
          baselineRaw || mcpPresetRaw,
          discoverForm,
        )
        await saveTenantCursorJson(mergedCursorJson)
      } catch (err) {
        cursorError = err?.message || String(err)
      }

      if (cursorError) {
        notify({
          title: 'Tools imported',
          message: `Imported ${importedCount} tool(s) for "${serverId}", but mcp.json save failed: ${cursorError}`,
          variant: 'warning',
          ttl: 9000,
        })
      } else {
        notify({
          title: 'Import complete',
          message: `Imported ${importedCount} tool(s) for server "${serverId}"`,
          variant: 'success',
          ttl: 6000,
        })
      }
      onImportSuccess?.()
    } catch (err) {
      notify({ title: 'Import failed', message: err.message || String(err), variant: 'error', ttl: 8000 })
    } finally {
      setImportSaving(false)
    }
  }

  const toggleAllDiscovered = () => {
    const allSelected = discoveredTools.length > 0 && discoveredTools.every(t => !!selectedDiscovered[t.name])
    const next = {}
    for (const t of discoveredTools) next[t.name] = !allSelected
    setSelectedDiscovered(next)
  }

  const onDiscoveredCheckChange = (idx, checked, withShift) => {
    const current = discoveredTools[idx]
    if (!current) return
    setSelectedDiscovered(prev => {
      const next = { ...prev, [current.name]: checked }
      if (
        withShift &&
        lastDiscoveredCheckedIdx !== null &&
        lastDiscoveredCheckedIdx >= 0 &&
        lastDiscoveredCheckedIdx < discoveredTools.length
      ) {
        const start = Math.min(lastDiscoveredCheckedIdx, idx)
        const end = Math.max(lastDiscoveredCheckedIdx, idx)
        for (let i = start; i <= end; i += 1) {
          const t = discoveredTools[i]
          if (t) next[t.name] = checked
        }
      }
      return next
    })
    setLastDiscoveredCheckedIdx(idx)
  }

  return {
    discovering,
    discoverForm,
    setDiscoverForm,
    discoveredTools,
    selectedDiscovered,
    showDiscovery,
    setShowDiscovery,
    mcpParseRaw,
    setMcpParseRaw,
    mcpPresetEntries,
    mcpPresetSelectedKey,
    mcpPresetWarnings,
    mcpPresetNpxDockerImage,
    setMcpPresetNpxDockerImage,
    discoveryConnectMode,
    setDiscoveryConnectMode,
    discoverServerIdHasSpaces,
    importSaving,
    parseCursorPresetJson,
    onMcpPresetServerChange,
    discoverExternalTools,
    discoverAfterZipImport,
    applyZipPackageToDiscoverForm,
    resetZipDiscoverSession,
    importDiscoveredTools,
    toggleAllDiscovered,
    onDiscoveredCheckChange,
  }
}
