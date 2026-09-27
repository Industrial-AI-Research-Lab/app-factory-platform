import { cleanAgentName } from './eventFacets.js'

// Joins per-run agent_llm_calls onto events. Events carry no model, so we index
// the calls by the keys events DO carry and resolve the finest available match.
// Only agent.invocation.captured carries call_id (=== _id); other events join by
// (agent, task, turn), and tool_executed has no turn at all — hence the ladder.

// Index the agent-llm-calls summary list. Callers pass the API's newest-first
// order (started_at desc); set-once therefore keeps the most recent call per key,
// which is what an agent-level fallback should surface.
export function buildModelIndex(items) {
  const byCall = new Map()
  const byKey = new Map()
  const setOnce = (k, v) => { if (k && !byKey.has(k)) byKey.set(k, v) }
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.model) continue
    const agent = it.agent_id ? cleanAgentName(it.agent_id) : ''
    if (!agent) continue
    const val = { model: it.model, callId: it._id ?? null }
    if (it._id) byCall.set(it._id, val)
    const { task_id: task, turn_index: turn } = it
    if (task != null && turn != null) setOnce(`${agent}|${task}|${turn}`, val)
    if (task != null) setOnce(`${agent}|${task}`, val)
    setOnce(agent, val)
  }
  return { byCall, byKey }
}

// Resolve an event to { model, callId } or null. Streaming events carry `round`
// (=== turn_index + 1); invocation.captured carries an exact call_id.
export function resolveModel(index, event) {
  if (!index || !event) return null
  const d = event.data || {}
  if (d.call_id && index.byCall.has(d.call_id)) return index.byCall.get(d.call_id)
  const agent = d.agent_id ? cleanAgentName(d.agent_id) : ''
  if (!agent) return null
  const task = d.task_id
  const turn = d.turn_index != null ? d.turn_index : (d.round != null ? d.round - 1 : null)
  const tries = []
  if (task != null && turn != null) tries.push(`${agent}|${task}|${turn}`)
  if (task != null) tries.push(`${agent}|${task}`)
  tries.push(agent)
  for (const k of tries) {
    if (index.byKey.has(k)) return index.byKey.get(k)
  }
  return null
}

// Build lookup maps from the config lists so events can name their server/address
// (events carry neither). MCP: tool wire-name -> {server, endpoint}. A2A: both the
// server id and its name -> {server, endpoint}, since a2a_agent_* events carry
// server_id while delegation events carry the server's name as child_agent.
export function buildConfigMaps(mcpTools, a2aServers) {
  const mcpByTool = new Map()
  for (const t of Array.isArray(mcpTools) ? mcpTools : []) {
    if (!t || !t.name) continue
    const server = t.mcp_server || ''
    const endpoint = t.metadata?.external_mcp?.endpoint || ''
    if (server || endpoint) mcpByTool.set(t.name, { server, endpoint })
  }
  const a2aByRef = new Map()
  for (const s of Array.isArray(a2aServers) ? a2aServers : []) {
    if (!s) continue
    const val = { server: s.name || '', endpoint: s.endpoint_url || '', id: s.id || s._id || '' }
    if (s.id) a2aByRef.set(s.id, val)
    if (s._id) a2aByRef.set(s._id, val)
    if (s.name) a2aByRef.set(s.name, val)
  }
  return { mcpByTool, a2aByRef }
}

// Resolve an event to { server, address } via config, or null. A2A first (its
// events carry no tool name), then MCP by tool wire-name; builtins/unknowns miss.
export function resolveServer(configMaps, event) {
  if (!configMaps || !event) return null
  const d = event.data || {}
  const a2aRef = d.server_id || (d.target_kind === 'a2a' ? d.child_agent : '')
  if (a2aRef && configMaps.a2aByRef && configMaps.a2aByRef.has(a2aRef)) {
    const v = configMaps.a2aByRef.get(a2aRef)
    return { server: v.server, address: v.endpoint, kind: 'a2a', editRef: v.id || v.server }
  }
  const tool = d.name || d.tool || d.tool_id || ''
  if (tool && configMaps.mcpByTool && configMaps.mcpByTool.has(tool)) {
    const v = configMaps.mcpByTool.get(tool)
    return { server: v.server, address: v.endpoint, kind: 'mcp', editRef: v.server }
  }
  return null
}

// Fetch the two catalogs the Server facet joins against and index them. MCP tools
// come from the mcp-tools catalog, NOT /configurations/tools/ — that one is
// builtin-only and excludes every MCP tool, so it would leave all MCP rows without
// a server. `getJson(path) -> parsed body | null` is injected so the wiring is
// testable; a null/failed list degrades to empty (rows render without a server).
export async function loadConfigMaps(getJson) {
  const [tools, a2a] = await Promise.all([
    getJson('/configurations/mcp-tools/'),
    getJson('/configurations/a2a/'),
  ])
  const mcp = Array.isArray(tools) ? tools : (tools?.items || [])
  const servers = Array.isArray(a2a) ? a2a : (a2a?.items || [])
  return buildConfigMaps(mcp, servers)
}

// Attach data joined from outside the event stream — per-request model plus the
// tool's server/address — onto already-annotated events, and fold the new text
// into `_search` so free-text search finds it (e.g. an MCP host or A2A ip).
// Fault-tolerant: a missing map just leaves its field empty and, when nothing was
// joined, preserves the original `_search`.
export function enrichEvents(events, { modelIndex, configMaps } = {}) {
  const arr = Array.isArray(events) ? events : []
  return arr.map((ev) => {
    const m = modelIndex ? resolveModel(modelIndex, ev) : null
    const s = configMaps ? resolveServer(configMaps, ev) : null
    const model = m?.model || ''
    const server = s?.server || ''
    const address = s?.address || ''
    const base = { ...ev, _model: model, _modelCallId: m?.callId || '', _server: server, _address: address, _serverKind: s?.kind || '', _serverEditRef: s?.editRef || '' }
    const extra = [model, server, address].filter(Boolean).join(' ').toLowerCase()
    return extra ? { ...base, _search: `${ev._search || ''} ${extra}` } : base
  })
}
