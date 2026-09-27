const PALETTES = {
  gray: { node: 'border-gray-500 bg-gray-800 text-gray-100', accent: 'bg-gray-400', edge: '#9ca3af' },
  slate: { node: 'border-slate-500 bg-slate-800 text-slate-100', accent: 'bg-slate-400', edge: '#94a3b8' },
  blue: { node: 'border-blue-500 bg-blue-950 text-blue-100', accent: 'bg-blue-400', edge: '#60a5fa' },
  emerald: { node: 'border-emerald-500 bg-emerald-950 text-emerald-100', accent: 'bg-emerald-400', edge: '#34d399' },
  violet: { node: 'border-violet-500 bg-violet-950 text-violet-100', accent: 'bg-violet-400', edge: '#a78bfa' },
  amber: { node: 'border-amber-500 bg-amber-950 text-amber-100', accent: 'bg-amber-400', edge: '#fbbf24' },
  sky: { node: 'border-sky-500 bg-sky-950 text-sky-100', accent: 'bg-sky-400', edge: '#38bdf8' },
  orange: { node: 'border-orange-500 bg-orange-950 text-orange-100', accent: 'bg-orange-400', edge: '#fb923c' },
  rose: { node: 'border-rose-500 bg-rose-950 text-rose-100', accent: 'bg-rose-400', edge: '#fb7185' },
  cyan: { node: 'border-cyan-500 bg-cyan-950 text-cyan-100', accent: 'bg-cyan-400', edge: '#22d3ee' },
  fuchsia: { node: 'border-fuchsia-500 bg-fuchsia-950 text-fuchsia-100', accent: 'bg-fuchsia-400', edge: '#e879f9' },
  purple: { node: 'border-purple-500 bg-purple-950 text-purple-100', accent: 'bg-purple-400', edge: '#c084fc' },
  teal: { node: 'border-teal-500 bg-teal-950 text-teal-100', accent: 'bg-teal-400', edge: '#2dd4bf' },
  pink: { node: 'border-pink-500 bg-pink-950 text-pink-100', accent: 'bg-pink-400', edge: '#f472b6' },
  indigo: { node: 'border-indigo-500 bg-indigo-950 text-indigo-100', accent: 'bg-indigo-400', edge: '#818cf8' },
  yellow: { node: 'border-yellow-500 bg-yellow-950 text-yellow-100', accent: 'bg-yellow-400', edge: '#facc15' },
  lime: { node: 'border-lime-500 bg-lime-950 text-lime-100', accent: 'bg-lime-400', edge: '#a3e635' },
  stone: { node: 'border-stone-500 bg-stone-800 text-stone-100', accent: 'bg-stone-400', edge: '#a8a29e' },
  red: { node: 'border-red-500 bg-red-950 text-red-100', accent: 'bg-red-400', edge: '#f87171' },
  green: { node: 'border-green-500 bg-green-950 text-green-100', accent: 'bg-green-400', edge: '#4ade80' },
  zinc: { node: 'border-zinc-500 bg-zinc-800 text-zinc-100', accent: 'bg-zinc-400', edge: '#a1a1aa' },
}

const EDGE_SEMANTICS = {
  contains: { label: 'contains', palette: 'slate' },
  starts: { label: 'starts', palette: 'blue' },
  uses: { label: 'uses', palette: 'amber' },
  delegates: { label: 'delegates', palette: 'violet' },
  returns: { label: 'returns', palette: 'violet' },
  called: { label: 'calls', palette: 'sky' },
  returned: { label: 'returns', palette: 'sky' },
  selected: { label: 'selected', palette: 'violet' },
  forked_from: { label: 'forked from', palette: 'violet' },
  reverted_to: { label: 'reverted to', palette: 'rose' },
  awaits_approval: { label: 'awaits approval', palette: 'orange' },
  produced: { label: 'produces', palette: 'emerald' },
  failed: { label: 'failed', palette: 'rose' },
}

const SHORT_TRACE_NODE_TYPES = new Set(['input', 'agent_attempt', 'delegation', 'tool', 'approval', 'result', 'output', 'error'])
const TRACE_TYPE_FILTERS = {
  agents: new Set(['agent_attempt', 'delegation']),
  llm: new Set(['llm_call']),
  tools: new Set(['tool', 'tool_call', 'tool_result']),
  checkpoints: new Set(['snapshot', 'rollback']),
}

const TRACE_REFRESH_MIN_INTERVAL_MS = 2000
const TRACE_REFRESH_EVENT_TYPES = new Set([
  'project_started', 'project_completed', 'project_failed', 'project_reverted',
  'task_attempt', 'task_completed', 'task_failed', 'task_error',
  'tool_call', 'tool_result', 'tool_executed', 'tool_started', 'tool_completed', 'tool_failed',
  'approval_requested', 'approval_approved', 'approval_rejected', 'approval_resolved',
  'snapshot_created', 'rollback', 'workflow_rollback', 'message_appended',
  'agent.invocation.captured', 'deployment_completed', 'deployment_failed',
  'auction_started', 'auction_bid_completed', 'auction_bid_timeout', 'auction_bid_failed',
  'auction_completed', 'auction_no_bids',
])

function isTraceRefreshEvent(event = {}) {
  const type = String(event.type ?? event.data?.event_type ?? '')
  return TRACE_REFRESH_EVENT_TYPES.has(type)
    || type.startsWith('phase.') || type.startsWith('phase_')
    || type.startsWith('workflow_node') || type.startsWith('workflow.')
    || type.startsWith('agent.delegation.') || type.startsWith('auction.')
    || type.startsWith('tool.') || type.startsWith('approval.')
    || type.startsWith('a2a_agent_') || type.startsWith('agent_invocation')
    || type.startsWith('artifact.') || type.startsWith('artifact_')
}

export function traceRefreshKey(events = []) {
  if (!Array.isArray(events) || events.length === 0) return ''
  const latest = [...events].reverse().find(isTraceRefreshEvent)
  if (!latest) return ''
  const id = latest.id ?? latest.data?.event_id ?? events.length
  const type = latest.type ?? latest.data?.event_type ?? ''
  return `${id}:${type}`
}

export function traceRefreshDelay(lastRequestAt, now = Date.now()) {
  if (!Number.isFinite(lastRequestAt)) return 0
  return Math.max(0, TRACE_REFRESH_MIN_INTERVAL_MS - Math.max(0, now - lastRequestAt))
}

export function traceProjectChanged(previousProjectId, projectId) {
  if (previousProjectId == null) return false
  return String(previousProjectId) !== String(projectId ?? '')
}

function shortNodeTypes(options) {
  const types = new Set(SHORT_TRACE_NODE_TYPES)
  if (options.includeLlm) types.add('llm_call')
  if (options.includeCheckpoints) {
    types.add('snapshot')
    types.add('rollback')
  }
  return types
}

export function visibleTraceSubgraph(trace, mode = 'full', options = {}) {
  const nodes = trace?.nodes || []
  if (mode === 'full') return nodes

  const byId = new Map(nodes.map(node => [node.id, node]))
  const allowedTypes = shortNodeTypes(options)
  const semanticNodes = nodes.filter(node => allowedTypes.has(node.type))
  const semanticIds = new Set(semanticNodes.map(node => node.id))
  const children = new Map()
  ;(trace.edges || []).filter(edge => semanticIds.has(edge.source) && semanticIds.has(edge.target))
    .forEach(edge => children.set(edge.source, [...(children.get(edge.source) || []), edge.target]))
  const hasExecutionAncestor = node => {
    let current = node
    const seen = new Set()
    while (current?.parent_id && !seen.has(current.parent_id)) {
      seen.add(current.parent_id)
      current = byId.get(current.parent_id)
      if (['input', 'task', 'agent_attempt', 'delegation'].includes(current?.type)) return true
    }
    return false
  }
  const reachable = new Set(semanticNodes
    .filter(node => node.type === 'input'
      || (node.type === 'agent_attempt' && hasExecutionAncestor(node))
      || (options.includeCheckpoints && ['snapshot', 'rollback'].includes(node.type)))
    .map(node => node.id))
  const pending = [...reachable]
  while (pending.length) {
    const sourceId = pending.shift()
    ;(children.get(sourceId) || []).forEach(targetId => {
      if (reachable.has(targetId)) return
      reachable.add(targetId)
      pending.push(targetId)
    })
  }

  return semanticNodes.filter(node => reachable.has(node.id))
}

export function shortTraceGraph(trace, options = {}) {
  const nodes = visibleTraceSubgraph(trace, 'short', options)
  const visibleIds = new Set(nodes.map(node => node.id))
  const input = nodes.find(node => node.type === 'input')
  const projectedNodes = nodes.map(node => {
    if (!['agent_attempt', 'snapshot', 'rollback'].includes(node.type)
      || !input || !node.parent_id || visibleIds.has(node.parent_id)) return node
    return { ...node, parent_id: input.id }
  })
  const edges = (trace?.edges || []).filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
  const edgePairs = new Set(edges.map(edge => `${edge.source}:${edge.target}`))
  projectedNodes.forEach(node => {
    const projectedType = node.type === 'agent_attempt' ? 'starts'
      : ['snapshot', 'rollback'].includes(node.type) ? 'contains' : null
    if (!projectedType || node.parent_id !== input?.id || edgePairs.has(`${input.id}:${node.id}`)) return
    edges.push({
      id: `short:${input.id}:${node.id}:${projectedType}`, source: input.id, target: node.id,
      type: projectedType, correlation: 'inferred',
    })
  })
  return { nodes: projectedNodes, edges }
}

function descendantsOf(nodes, rootIds) {
  const children = new Map()
  nodes.forEach(node => {
    if (!node.parent_id) return
    children.set(node.parent_id, [...(children.get(node.parent_id) || []), node.id])
  })
  const hidden = new Set(rootIds)
  const pending = [...hidden]
  while (pending.length) {
    const parentId = pending.shift()
    ;(children.get(parentId) || []).forEach(childId => {
      if (hidden.has(childId)) return
      hidden.add(childId)
      pending.push(childId)
    })
  }
  return hidden
}

function filterEdges(edges, nodes) {
  const visibleIds = new Set(nodes.map(node => node.id))
  return edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
}

export function traceGraphForView(trace, mode = 'full', settings = {}) {
  const base = mode === 'short'
    ? shortTraceGraph(trace, {
      includeLlm: settings.enabled?.llm === true,
      includeCheckpoints: settings.enabled?.checkpoints === true,
    })
    : { nodes: trace?.nodes || [], edges: trace?.edges || [] }
  const runId = settings.runId || null
  const runScopedNodes = runId
    ? base.nodes.filter(node => node.type === 'input' || (mode === 'full' && node.type === 'project') || node.run_id === runId)
    : base.nodes
  const disabledRoots = Object.entries(TRACE_TYPE_FILTERS)
    .filter(([filter]) => settings.enabled?.[filter] === false)
    .flatMap(([, types]) => runScopedNodes.filter(node => types.has(node.type)).map(node => node.id))
  const hiddenByTypes = descendantsOf(runScopedNodes, disabledRoots)
  const afterTypes = runScopedNodes.filter(node => !hiddenByTypes.has(node.id))
  const collapsedIds = new Set(settings.collapsedIds || [])
  const hiddenByCollapse = descendantsOf(afterTypes, collapsedIds)
  collapsedIds.forEach(nodeId => hiddenByCollapse.delete(nodeId))
  const afterCollapse = afterTypes.filter(node => !hiddenByCollapse.has(node.id))
  return { nodes: afterCollapse, edges: filterEdges(base.edges, afterCollapse) }
}

export const TRACE_LEGEND = [
  ['Project', 'gray'], ['Input', 'slate'], ['Run', 'violet'], ['Phase', 'sky'], ['Workflow node', 'cyan'],
  ['Task', 'blue'], ['Auction', 'fuchsia'], ['Auction bid', 'purple'], ['Local agent', 'teal'],
  ['A2A agent', 'emerald'], ['Delegation', 'pink'], ['LLM turn', 'indigo'], ['Tool', 'amber'],
  ['Tool call', 'yellow'], ['Tool result', 'lime'], ['HITL', 'orange'], ['Snapshot', 'stone'],
  ['Rollback', 'rose'], ['Error', 'red'], ['Result', 'green'], ['Output', 'zinc'],
]

export function paletteForNode(node) {
  if (node.type === 'project') return 'gray'
  if (node.type === 'input') return 'slate'
  if (node.type === 'run') return 'violet'
  if (node.type === 'phase') return 'sky'
  if (node.type === 'workflow_node') return 'cyan'
  if (node.type === 'task') return 'blue'
  if (node.type === 'auction') return 'fuchsia'
  if (node.type === 'auction_bid') return 'purple'
  if (node.type === 'agent_attempt') return node.details?.execution_kind === 'a2a' ? 'emerald' : 'teal'
  if (node.type === 'delegation') return 'pink'
  if (node.type === 'llm_call') return 'indigo'
  if (node.type === 'tool') return 'amber'
  if (node.type === 'tool_call') return 'yellow'
  if (node.type === 'tool_result') return 'lime'
  if (node.type === 'approval') return 'orange'
  if (node.type === 'snapshot') return 'stone'
  if (node.type === 'rollback') return 'rose'
  if (node.type === 'error') return 'red'
  if (node.type === 'result') return 'green'
  if (node.type === 'output') return 'zinc'
  return 'slate'
}

export function displayStatus(node) {
  const stored = node.details?.display_status
  return ['running', 'completed', 'failed', 'unknown'].includes(stored) ? stored : 'unknown'
}

export function normalizeTraceSearch(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

export function traceSearchText(node) {
  const details = node?.details || {}
  return normalizeTraceSearch([
    node?.id,
    node?.title,
    node?.summary,
    node?.run_id,
    node?.task_id,
    node?.agent_id,
    node?.tool_call_id,
    node?.workflow_node_id,
    details.run_id,
    details.task_id,
    details.agent_id,
    details.agent_name,
    details.agent_display_name,
    details.tool_call_id,
    details.workflow_node_id,
    details.source_message_id,
    details.tool_name,
    details.artifact_id,
    details.deployment_id,
  ].filter(value => value !== undefined && value !== null && value !== '').join(' '))
}

export function findTraceMatches(nodes = [], query = '') {
  const needle = normalizeTraceSearch(query).trim()
  if (!needle) return []
  const source = Array.isArray(nodes) ? nodes : []
  return source.filter(node => traceSearchText(node).includes(needle))
}

export function visibleStatus(node) {
  const status = displayStatus(node)
  return status === 'unknown' ? null : status
}

function invocationParts(node) {
  const details = node.details || {}
  const status = visibleStatus(node)
  if (node.type === 'agent_attempt') return [details.agent_name || node.title || 'Agent', node.summary || null, status]
  if (node.type === 'delegation') return [node.title || 'Delegation', 'delegated', status]
  if (node.type === 'tool') return [details.agent_name || null, details.tool_name || node.title || 'Tool', status]
  if (node.type === 'input') return ['Input', node.summary || 'Task', null]
  if (node.type === 'approval') return ['HITL', node.summary || 'approval', status]
  if (node.type === 'error') return ['Error', node.summary || 'Execution failed', 'failed']
  if (node.type === 'result') return ['Result', node.summary || null, status]
  if (node.type === 'output') return ['Output', node.summary || null, status]
  return [node.title || node.type, node.summary || null, status]
}

export function formatInvocation(node) {
  return invocationParts(node).filter(Boolean).join(' · ')
}

export function invocationCountBadges(counts = {}) {
  return [
    ['llm', 'LLM', counts.llm_calls],
    ['tools', 'Tools', counts.tool_calls],
  ].filter(([, , count]) => Number.isFinite(count) && count > 0)
    .map(([kind, label, count]) => ({ kind, label: `${label} ${count}` }))
}

export function traceNodeView(traceNode, position) {
  const [primary, action, status] = invocationParts(traceNode)
  const palette = paletteForNode(traceNode)
  return {
    id: traceNode.id,
    type: 'trace',
    position,
    data: {
      trace: traceNode, primary, action, status, palette,
      paletteClass: PALETTES[palette].node, accentClass: PALETTES[palette].accent,
      label: formatInvocation(traceNode), counts: traceNode.counts || {}, active: Boolean(traceNode.details?.active),
    },
  }
}

export function traceEdgeView(traceEdge) {
  const semantic = EDGE_SEMANTICS[traceEdge.type] || EDGE_SEMANTICS.starts
  const palette = PALETTES[semantic.palette]
  const inferred = traceEdge.correlation === 'inferred'
  const isReturn = ['returns', 'returned', 'reverted_to'].includes(traceEdge.type)
  return {
    id: traceEdge.id, source: traceEdge.source, target: traceEdge.target, type: 'smoothstep', label: semantic.label,
    sourceHandle: isReturn ? 'return-source' : 'tree-source',
    targetHandle: isReturn ? 'return-target' : 'tree-target',
    pathOptions: { offset: isReturn ? 180 : 24 },
    markerEnd: { type: 'arrowclosed', color: palette.edge },
    style: { stroke: palette.edge, strokeWidth: 2, ...(inferred ? { strokeDasharray: '5 4' } : {}) },
    labelStyle: { fill: palette.edge, fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: '#0f172a', fillOpacity: 0.92 },
    data: { traceType: traceEdge.type, palette: semantic.palette },
  }
}

export const TRACE_LAYOUT_X_GAP = 280
export const TRACE_LAYOUT_Y_GAP = 150
export const TRACE_SEARCH_MIN_ZOOM = 0.7
export const TRACE_SEARCH_MAX_COLUMNS = 5
export const TRACE_SEARCH_MAX_ROWS = 6
export const TRACE_SEARCH_MAX_NODES = 30
export const TRACE_SEARCH_MAX_ZOOM = 16
const SEARCH_NODE_WIDTH = 220
const SEARCH_NODE_HEIGHT = 90

export function countSearchViewportNodes(nodes, center = {}, width = 0, height = 0, zoom = TRACE_SEARCH_MIN_ZOOM) {
  const source = Array.isArray(nodes) ? nodes : []
  const canvasWidth = Number.isFinite(width) && width > 0 ? width : 1000
  const canvasHeight = Number.isFinite(height) && height > 0 ? height : 600
  const centerX = Number.isFinite(center?.x) ? center.x : 0
  const centerY = Number.isFinite(center?.y) ? center.y : 0
  const currentZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : TRACE_SEARCH_MIN_ZOOM
  const left = centerX - canvasWidth / (2 * currentZoom)
  const right = centerX + canvasWidth / (2 * currentZoom)
  const top = centerY - canvasHeight / (2 * currentZoom)
  const bottom = centerY + canvasHeight / (2 * currentZoom)

  return source.filter(node => {
    const position = node.positionAbsolute || node.position || {}
    const x = Number.isFinite(position.x) ? position.x : 0
    const y = Number.isFinite(position.y) ? position.y : 0
    const nodeWidth = node.width || node.measured?.width || SEARCH_NODE_WIDTH
    const nodeHeight = node.height || node.measured?.height || SEARCH_NODE_HEIGHT
    return x < right && x + nodeWidth > left && y < bottom && y + nodeHeight > top
  }).length
}

export function searchViewportZoom(width = 0, height = 0, nodes = [], center = null) {
  const canvasWidth = Number.isFinite(width) && width > 0 ? width : 1000
  const canvasHeight = Number.isFinite(height) && height > 0 ? height : 600
  let zoom = Math.max(
    TRACE_SEARCH_MIN_ZOOM,
    canvasWidth / (TRACE_SEARCH_MAX_COLUMNS * TRACE_LAYOUT_X_GAP),
    canvasHeight / (TRACE_SEARCH_MAX_ROWS * TRACE_LAYOUT_Y_GAP),
  )
  if (!Array.isArray(nodes) || !center) return zoom

  while (zoom < TRACE_SEARCH_MAX_ZOOM
    && countSearchViewportNodes(nodes, center, canvasWidth, canvasHeight, zoom) > TRACE_SEARCH_MAX_NODES) {
    zoom *= 1.25
  }
  return Math.min(zoom, TRACE_SEARCH_MAX_ZOOM)
}

export function layoutTraceNodes(traceNodes) {
  const byId = new Map(traceNodes.map(node => [node.id, node]))
  const chronology = node => {
    const rawTimestamp = node.started_at || node.created_at || node.details?.started_at
    const timestamp = rawTimestamp ? Date.parse(rawTimestamp) : Number.MAX_SAFE_INTEGER
    return [node.sequence ?? Number.MAX_SAFE_INTEGER, Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER, node.id]
  }
  const compare = (left, right) => {
    const [ls, lt, li] = chronology(left)
    const [rs, rt, ri] = chronology(right)
    return ls - rs || lt - rt || String(li).localeCompare(String(ri))
  }
  const children = new Map()
  traceNodes.forEach(node => {
    if (node.parent_id && byId.has(node.parent_id)) children.set(node.parent_id, [...(children.get(node.parent_id) || []), node])
  })
  children.forEach(nodes => nodes.sort(compare))
  const lanes = new Map()
  const cycleNodes = new Set()
  let nextLane = 0
  const assignLane = (node, visiting = new Set(), path = []) => {
    if (lanes.has(node.id)) return lanes.get(node.id)
    if (visiting.has(node.id)) {
      const cycleStart = path.indexOf(node.id)
      path.slice(cycleStart).forEach(id => cycleNodes.add(id))
      return nextLane++
    }
    const nextVisiting = new Set(visiting)
    nextVisiting.add(node.id)
    const nextPath = [...path, node.id]
    const childLanes = (children.get(node.id) || []).map(child => assignLane(child, nextVisiting, nextPath))
    const lane = childLanes.length ? (childLanes[0] + childLanes[childLanes.length - 1]) / 2 : nextLane++
    lanes.set(node.id, lane)
    return lane
  }
  const roots = traceNodes.filter(node => !node.parent_id || !byId.has(node.parent_id)).sort(compare)
  roots.forEach(node => assignLane(node))
  // A parent cycle has no root by definition.  Give each unvisited component
  // a deterministic lane so malformed data cannot leave nodes overlapping at
  // the origin.
  traceNodes.slice().sort(compare).forEach(node => {
    if (!lanes.has(node.id)) assignLane(node)
  })
  // Keep every member of a malformed cyclic component visible in a separate
  // deterministic lane instead of allowing the recursive fallback to overlap.
  Array.from(cycleNodes).sort((left, right) => compare(byId.get(left), byId.get(right)))
    .forEach(id => lanes.set(id, nextLane++))
  const depths = new Map()
  const depthOf = (node, visiting = new Set()) => {
    if (depths.has(node.id)) return depths.get(node.id)
    if (visiting.has(node.id)) return 0
    const nextVisiting = new Set(visiting)
    nextVisiting.add(node.id)
    const depth = node.parent_id && byId.has(node.parent_id) ? depthOf(byId.get(node.parent_id), nextVisiting) + 1 : 0
    depths.set(node.id, depth)
    return depth
  }
  const deepestWorkNode = Math.max(0, ...traceNodes.filter(node => node.type !== 'output').map(node => depthOf(node)))
  return [...traceNodes].sort(compare).map(node => traceNodeView(node, {
    x: (lanes.get(node.id) || 0) * TRACE_LAYOUT_X_GAP,
    y: (node.type === 'output' ? deepestWorkNode + 1 : depthOf(node)) * TRACE_LAYOUT_Y_GAP,
  }))
}
