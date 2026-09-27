import { stripTrailingCommasForMcpJson } from '../../utils/mcp_cursor_preset'
export { groupToolsByServer, isZipHostedMcpGroup, isHttpConnectionSettingsGroup } from './mcpServerGroups'

export function parseEnvVars(raw) {
  if (!raw || !raw.trim()) return null
  const result = {}
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx < 1) continue
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    if (k) result[k] = v
  }
  return Object.keys(result).length ? result : null
}

export function parseCmdArgs(raw) {
  if (!raw || !raw.trim()) return null
  return raw.trim().split(/\s+/).filter(Boolean)
}

export function hasWhitespace(value) {
  return /\s/.test(String(value || ''))
}

export function formatHealthCheckTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(d)
  } catch {
    return String(iso)
  }
}

export function emptyDiscoverForm() {
  return {
    server_id: '',
    mode: 'http',
    timeout_seconds: 30,
    mcp_runtime_scope: 'project',
    mcp_idle_timeout: '',
    mcp_on_project_complete: 'remove',
    mcp_source: '',
    endpoint: '',
    headers: [],
    image: '',
    docker_env_vars_raw: '',
    docker_cmd_args_raw: '',
    command: '',
    command_args_raw: '',
    command_env_raw: '',
  }
}

export function emptyMcpToolForm() {
  return {
    id: '',
    name: '',
    rpc_name: '',
    description: '',
    short_description: '',
    long_description: '',
    category: 'mcp',
    source: 'mcp_server',
    mcp_server: '',
    enabled: true,
    mcp_runtime_scope: 'project',
    mcp_idle_timeout: '',
    mcp_on_project_complete: 'remove',
  }
}

export function isMcpTool(tool) {
  return tool?.source === 'mcp_server'
}

/** Wire blank category arrives as __unassigned__; MCP UI shows mcp. */
export function mcpCategoryLabel(category) {
  const trimmed = String(category ?? '').trim()
  if (!trimmed || trimmed === '__unassigned__') return 'mcp'
  return trimmed
}

export function healthStatusLabel(status) {
  if (status === 'policy_blocked') return 'allowlist'
  if (status === 'not_found') return 'not found'
  return status || '—'
}

export function healthStatusColor(status) {
  if (status === 'ok') return 'text-green-400'
  if (status === 'policy_blocked' || status === 'skipped') return 'text-amber-300'
  if (status === 'not_found') return 'text-slate-400'
  return 'text-red-400'
}

export { aggregateServerHealthRow, healthRuntimeKey, mergeHealthResult } from './healthMerge'

export function upsertServerIntoCursorJsonText(rawText, form) {
  const baseText = (rawText || '').trim() || '{"mcpServers": {}}'
  let parsed
  try {
    parsed = JSON.parse(stripTrailingCommasForMcpJson(baseText))
  } catch {
    parsed = { mcpServers: {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = { mcpServers: {} }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
    parsed.mcpServers = {}
  }
  const sid = String(form.server_id || '').trim()
  if (!sid) return JSON.stringify(parsed, null, 2)
  const timeoutMs = Math.max(1, Number(form.timeout_seconds) || 30) * 1000
  let entry = {}
  if (form.mode === 'stdio') {
    if (String(form.image || '').trim()) {
      entry = {
        image: String(form.image || '').trim(),
        args: parseCmdArgs(form.docker_cmd_args_raw) || [],
        env: parseEnvVars(form.docker_env_vars_raw) || {},
        timeout: timeoutMs,
        disabled: false,
      }
    } else if (String(form.command || '').trim()) {
      entry = {
        command: String(form.command || '').trim(),
        args: parseCmdArgs(form.command_args_raw) || [],
        env: parseEnvVars(form.command_env_raw) || {},
        timeout: timeoutMs,
        disabled: false,
      }
    } else {
      entry = { timeout: timeoutMs, disabled: false }
    }
  } else {
    entry = {
      url: String(form.endpoint || '').trim(),
      transport: form.mode === 'streamable-http' ? 'streamable-http' : 'http',
      timeout: timeoutMs,
      disabled: false,
    }
    const hdrs = (form.headers || []).filter(h => (h.name || '').trim())
    if (hdrs.length) {
      const hobj = {}
      for (const h of hdrs) hobj[String(h.name).trim()] = String(h.value || '')
      entry.headers = hobj
    }
  }
  parsed.mcpServers[sid] = entry
  return JSON.stringify(parsed, null, 2)
}
