import { stripTrailingCommasForMcpJson } from './mcp_cursor_preset'

const MCP_TOOL_NAME_SAFE = /^[a-zA-Z0-9_-]+$/
const MCP_SERVER_ID_SAFE = /^[a-zA-Z0-9_-]+$/

export function sanitizeMcpToolName(name) {
  const raw = String(name || '').trim()
  if (!raw) return { name: raw, changed: false }
  if (MCP_TOOL_NAME_SAFE.test(raw)) return { name: raw, changed: false }
  let cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  if (!cleaned) cleaned = 'tool'
  return { name: cleaned, changed: true }
}

export function parseMcpServersObject(text) {
  const trimmed = (text || '').trim()
  if (!trimmed) return { mcpServers: {}, error: null }
  try {
    const parsed = JSON.parse(stripTrailingCommasForMcpJson(trimmed))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { mcpServers: null, error: 'JSON must be an object with mcpServers' }
    }
    const servers = parsed.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { mcpServers: null, error: 'Missing or invalid mcpServers object' }
    }
    return { mcpServers: servers, error: null }
  } catch (e) {
    return { mcpServers: null, error: e.message || String(e) }
  }
}

/** Normalize tool names in tools/disabledTools; collect warnings. */
export function sanitizeMcpServersForSave(mcpServers) {
  const warnings = []
  const errors = []
  const out = {}
  if (!mcpServers || typeof mcpServers !== 'object') {
    return { mcpServers: {}, warnings, errors, sanitizedText: null }
  }
  for (const [sidRaw, entry] of Object.entries(mcpServers)) {
    const sid = String(sidRaw || '').trim()
    if (!sid) continue
    if (!MCP_SERVER_ID_SAFE.test(sid)) {
      errors.push(`Server key "${sidRaw}" is invalid. Use only letters, numbers, hyphen, and underscore (no spaces).`)
      continue
    }
    const entryCopy = entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : {}
    for (const key of ['tools', 'disabledTools']) {
      if (!Array.isArray(entryCopy[key])) continue
      entryCopy[key] = entryCopy[key].map((item) => {
        const s = String(item || '').trim()
        if (!s) return s
        const { name, changed } = sanitizeMcpToolName(s)
        if (changed) {
          warnings.push(
            `Tool "${s}" in server "${sid}" (${key}) was normalized to "${name}" (allowed: a-z, A-Z, 0-9, _, -).`
          )
        }
        return name
      }).filter(Boolean)
    }
    out[sid] = entryCopy
  }
  const sanitizedText = JSON.stringify({ mcpServers: out }, null, 2)
  return { mcpServers: out, warnings, errors, sanitizedText }
}

function toolsSelectionSignature(entry) {
  if (!entry || typeof entry !== 'object') return null
  const hasTools = Array.isArray(entry.tools)
  const hasDisabled = Array.isArray(entry.disabledTools)
  if (!hasTools && !hasDisabled) return null
  const enabled = hasTools
    ? [...entry.tools].map(t => String(t).trim()).filter(Boolean).sort()
    : []
  const disabled = hasDisabled
    ? [...entry.disabledTools].map(t => String(t).trim()).filter(Boolean).sort()
    : []
  return JSON.stringify({ enabled, disabled })
}

/** Client-side preview of what save will do (matches backend diff). */
export function diffMcpServersJson(baselineText, currentText) {
  const base = parseMcpServersObject(baselineText)
  const cur = parseMcpServersObject(currentText)
  if (base.error) return { error: base.error, preview: null }
  if (cur.error) return { error: cur.error, preview: null }
  const oldServers = base.mcpServers || {}
  const newServers = cur.mcpServers || {}
  const oldKeys = new Set(Object.keys(oldServers))
  const newKeys = new Set(Object.keys(newServers))
  const added = [...newKeys].filter(k => !oldKeys.has(k)).sort()
  const removed = [...oldKeys].filter(k => !newKeys.has(k)).sort()
  const unchanged = []
  const toolListChanged = []
  for (const sid of [...oldKeys].filter(k => newKeys.has(k)).sort()) {
    const newSig = toolsSelectionSignature(newServers[sid])
    if (newSig == null) {
      unchanged.push(sid)
      continue
    }
    const oldSig = toolsSelectionSignature(oldServers[sid])
    if (oldSig === newSig) unchanged.push(sid)
    else toolListChanged.push(sid)
  }
  for (const sid of added) {
    if (toolsSelectionSignature(newServers[sid]) != null) toolListChanged.push(sid)
  }
  return {
    error: null,
    preview: {
      added_servers: added,
      removed_servers: removed,
      unchanged_servers: unchanged,
      servers_tool_list_changed: [...new Set(toolListChanged)].sort(),
    },
  }
}
