export function isZipHostedMcpGroup(group) {
  return (group?.tools || []).some(tool => {
    const runtime = tool?.metadata?.external_mcp
    return runtime?.source === 'zip' && Boolean(String(runtime.image || '').trim())
  })
}

/** Connection Settings apply to remote HTTP transports only (not stdio). */
export function isHttpConnectionSettingsGroup(group) {
  const tools = group?.tools || []
  if (!tools.length) return false
  const sample =
    tools.find((t) => String(t?.tenant_id || '') !== '__system__') || tools[0]
  const mode = String(sample?.metadata?.external_mcp?.mode || 'http')
    .trim()
    .toLowerCase()
  return mode === 'http' || mode === 'streamable-http'
}

export function isRestartableZipMcpGroup(group) {
  const tools = group?.tools || []
  const restartContracts = tools.map(tool => {
    const runtime = tool?.metadata?.external_mcp
    if (String(runtime?.source || '').trim().toLowerCase() !== 'zip'
      || !String(runtime?.image || '').trim()
      || String(runtime?.mode || 'http').trim().toLowerCase() !== 'streamable-http'
      || String(runtime?.runtime_scope || 'project').trim().toLowerCase() !== 'tenant') {
      return null
    }
    const containerPort = Number(runtime?.container_port || 8080)
    if (!Number.isInteger(containerPort)) return null
    return JSON.stringify({
      source: 'zip',
      image: String(runtime.image).trim(),
      mode: 'streamable-http',
      runtime_scope: 'tenant',
      container_port: containerPort,
      path: String(runtime.path || runtime.endpoint_path || '/mcp'),
      docker_env_vars: normalizedJson(runtime.docker_env_vars),
      docker_cmd_args: Array.isArray(runtime.docker_cmd_args) ? runtime.docker_cmd_args : null,
      idle_timeout_seconds: runtime.idle_timeout_seconds ?? null,
      on_project_complete: String(runtime.on_project_complete || 'remove'),
    })
  })
  return restartContracts.length > 0
    && restartContracts[0] !== null
    && restartContracts.every(contract => contract === restartContracts[0])
}

function normalizedJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, entry]),
  )
}

export function groupToolsByServer(tools) {
  const map = new Map()
  for (const tool of tools || []) {
    const tenantId = String(tool?.tenant_id || '__root__').trim() || '__root__'
    const serverId = String(tool?.mcp_server || '').trim() || '(no server)'
    const groupKey = `${tenantId}:${serverId}`
    if (!map.has(groupKey)) {
      map.set(groupKey, { groupKey, tenantId, serverId, tools: [] })
    }
    map.get(groupKey).tools.push(tool)
  }
  return [...map.values()]
    .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    .map(group => ({
      ...group,
      isZipHosted: isZipHostedMcpGroup(group),
      isRestartableZip: isRestartableZipMcpGroup(group),
      tools: group.tools.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    }))
}
