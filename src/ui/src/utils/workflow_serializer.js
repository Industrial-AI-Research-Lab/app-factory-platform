/**
 * Workflow Serializer — converts between React Flow format and backend API format.
 *
 * Backend format (MongoDB / API):
 *   nodes: [{ id, type, task_type?, description?, agent_selection?, agent_type?, phase_label?, label? }]
 *   edges: [{ from, to, condition? }]
 *
 * React Flow format:
 *   nodes: [{ id, type, position: {x,y}, data: {...} }]
 *   edges: [{ id, source, target, sourceHandle?, data: { condition? } }]
 */

const NODE_TYPE_MAP = {
  start: 'startNode',
  end: 'endNode',
  phase: 'phaseNode',
  approval_gate: 'approvalGateNode',
  execution: 'executionNode',
  deploy: 'deployNode',
  a2a_agent: 'a2aNode',
  validator: 'validatorNode',
  tool: 'toolNode',
  map: 'mapNode',
}

const TOOL_NODE_FIELDS = ['operation', 'server', 'binding']
const MAP_NODE_TEXT_FIELDS = ['items_from', 'item_key']
const MAP_NODE_NUMBER_FIELDS = ['batch_size', 'concurrency', 'max_item_attempts']

const RF_TYPE_TO_BACKEND = Object.fromEntries(
  Object.entries(NODE_TYPE_MAP).map(([k, v]) => [v, k])
)

export const FULL_CONTEXT_READS_TOKEN = '*'
export const WORKFLOW_DEFAULT_READS_TOKEN = '$workflow_defaults'
export const SYSTEM_BASE_READ_KEYS = ['user_prompt', 'conversation_history']
export const READ_KEY_SUGGESTIONS = [
  'user_prompt',
  'conversation_history',
  'requirements',
  'plan',
  'artifacts',
  'decisions',
  'insights',
]
export const WRITE_KEY_SUGGESTIONS = ['requirements', 'plan', 'analysis', 'summary', 'plan_v2']
export const READ_ONLY_WRITE_KEYS = [
  'user_prompt',
  'conversation_history',
  'artifacts',
  'decisions',
  'insights',
  'deploy_status',
  'deploy_error',
  'deployments',
  'custom_context',
  'project_id',
  'created_at',
  'run_config',
  'status',
  'updated_at',
]

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key)
}

export function normalizeContractKeyList(value) {
  if (!Array.isArray(value)) return []

  const seen = new Set()
  const normalized = []
  for (const item of value) {
    const key = String(item || '').trim()
    if (!key || seen.has(key)) continue
    normalized.push(key)
    seen.add(key)
  }
  return normalized
}

export function withoutKeys(values = [], keysToRemove = []) {
  const remove = new Set(keysToRemove)
  return normalizeContractKeyList(values).filter(key => !remove.has(key))
}

export function mergeContractKeys(...groups) {
  return normalizeContractKeyList(groups.flat())
}

// Kept in lockstep with the backend caps (schemas/configuration_schemas.py); drift
// makes the editor accept a value the API then rejects with an inline-unactionable 422.
export const WORKFLOW_PROMPT_NAME_MAX_LEN = 200
export const WORKFLOW_PROMPT_TEXT_MAX_LEN = 20000

/**
 * Example prompts offered on the launch screen: keep only rows that
 * carry both a name and text (trimmed), dropping empties. Used both to render the
 * launch-screen options and to build the save payload, so a stored-but-malformed
 * row (a direct Mongo edit — the API read is lenient) never reaches either.
 */
export function sanitizeWorkflowPrompts(prompts) {
  if (!Array.isArray(prompts)) return []
  const out = []
  for (const p of prompts) {
    const name = String(p?.name ?? '').trim()
    const text = String(p?.text ?? '').trim()
    if (name && text) out.push({ name, text })
  }
  return out
}

/**
 * Human-readable problems with in-progress prompt rows, for editor save-gating.
 * Flags a half-filled row (one of name/text) — else the author's typed value is lost
 * to sanitizeWorkflowPrompts' silent drop — and an over-long name/text, which the
 * `maxLength` inputs can't catch on a row loaded from a direct Mongo edit and which
 * would otherwise surface as an opaque 422 on save. Empty scaffold rows are fine.
 */
export function getWorkflowPromptIssues(prompts) {
  if (!Array.isArray(prompts)) return []
  const issues = []
  prompts.forEach((p, i) => {
    const name = String(p?.name ?? '').trim()
    const text = String(p?.text ?? '').trim()
    if (name && !text) issues.push(`Example prompt ${i + 1} ("${name}") needs prompt text`)
    else if (!name && text) issues.push(`Example prompt ${i + 1} needs a name`)
    if (name.length > WORKFLOW_PROMPT_NAME_MAX_LEN) {
      issues.push(`Example prompt ${i + 1} name exceeds ${WORKFLOW_PROMPT_NAME_MAX_LEN} characters`)
    }
    if (text.length > WORKFLOW_PROMPT_TEXT_MAX_LEN) {
      issues.push(`Example prompt ${i + 1} text exceeds ${WORKFLOW_PROMPT_TEXT_MAX_LEN} characters`)
    }
  })
  return issues
}

/**
 * Context keys an a2a node's `reads[].context_key` can read from — for editor autocomplete.
 *
 * Two sources: the always-present readable keys (user_prompt, plan, …) and every key any
 * OTHER node declares it writes. We deliberately suggest writes from ALL other nodes, not
 * just graph-upstream ones: the engine has no reachability check — a read whose key isn't
 * populated yet resolves to None and is silently skipped (workflow_engine `_build_a2a_message`).
 * So this is a guide, not a constraint, and the field stays free-text for runtime-only keys.
 *
 * Returns `[{ key, source }]` (source = 'workflow context' or 'from <nodeId>'), deduped with
 * first-seen winning so the base readable keys keep their friendly source label.
 */
export function collectContextKeyOptions(nodes = [], currentNodeId = null) {
  const out = []
  const seen = new Set()
  const add = (rawKey, source) => {
    const key = String(rawKey || '').trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ key, source })
  }

  for (const key of READ_KEY_SUGGESTIONS) add(key, 'workflow context')

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.id === currentNodeId) continue
    const data = node.data || {}
    if (data.nodeType === 'a2a_agent') {
      // a2a writes are dicts {artifact_name, context_key}; the landing key is context_key
      // (defaults to artifact_name in the engine), so that's what a downstream read pulls.
      for (const w of Array.isArray(data.writes) ? data.writes : []) {
        add(w?.context_key || w?.artifact_name, `from ${node.id}`)
      }
    } else {
      // phase/other nodes write plain string keys
      for (const key of normalizeContractKeyList(data.writes)) {
        if (key === FULL_CONTEXT_READS_TOKEN || key === WORKFLOW_DEFAULT_READS_TOKEN) continue
        add(key, `from ${node.id}`)
      }
    }
  }
  return out
}

function copyContractKeyList(target, source, key) {
  if (!hasOwn(source, key) || source[key] == null) return
  target[key] = normalizeContractKeyList(source[key])
}

function copyMaxRetries(target, source) {
  if (!hasOwn(source, 'max_retries') || source.max_retries == null || source.max_retries === '') return
  const parsed = Number(source.max_retries)
  if (Number.isInteger(parsed)) target.max_retries = parsed
}

// validator-only per-reject retry cap (AppFactory-77 F3). Same round-trip discipline as
// max_retries: without this a cap set via API/import is silently dropped on a UI save.
function copyMaxRejectRetries(target, source) {
  if (!hasOwn(source, 'max_reject_retries') || source.max_reject_retries == null || source.max_reject_retries === '') return
  const parsed = Number(source.max_reject_retries)
  if (Number.isInteger(parsed)) target.max_reject_retries = parsed
}

// a2a_agent reads/writes are structured dicts (reads {key,context_key,part,value},
// writes {artifact_name,context_key,required}) — NOT plain string keys like phase nodes.
// Running them through normalizeContractKeyList would stringify each dict to
// "[object Object]" and destroy the node, so a2a copies the rows verbatim.
function copyA2aSpecList(source, key) {
  return Array.isArray(source?.[key]) ? source[key].map(row => ({ ...row })) : []
}

/**
 * Auto-layout nodes in a simple top-down arrangement.
 * Returns a map of nodeId -> { x, y }.
 */
function autoLayout(apiNodes, apiEdges) {
  const positions = {}
  const X_CENTER = 400
  const Y_START = 60
  const Y_STEP = 200
  const X_OFFSET = 280

  // Build adjacency from edges (excluding rejected back-edges for layout)
  const forwardChildren = {}  // only forward/approved edges for BFS ordering
  const allChildren = {}
  for (const e of apiEdges) {
    const src = e.from || e.source
    const tgt = e.to || e.target
    if (!allChildren[src]) allChildren[src] = []
    allChildren[src].push({ to: tgt, condition: e.condition })
    // Skip rejected edges for layout — they're back-edges to already-visited nodes
    if (e.condition === 'rejected') continue
    if (!forwardChildren[src]) forwardChildren[src] = []
    forwardChildren[src].push({ to: tgt, condition: e.condition })
  }

  // Find start node
  const startNode = apiNodes.find(n => n.type === 'start')
  if (!startNode) {
    apiNodes.forEach((n, i) => {
      positions[n.id] = { x: X_CENTER, y: Y_START + i * Y_STEP }
    })
    return positions
  }

  // BFS using only forward edges — produces a clean top-down ordering
  const visited = new Set()
  const nodeDepth = {}  // nodeId -> depth
  const queue = [{ id: startNode.id, depth: 0 }]

  while (queue.length > 0) {
    const { id, depth } = queue.shift()
    if (visited.has(id)) continue
    visited.add(id)
    nodeDepth[id] = depth

    const kids = forwardChildren[id] || []
    // Sort: approved first, then default — keeps main path centered
    kids.sort((a, b) => {
      if (a.condition === 'approved') return -1
      if (b.condition === 'approved') return 1
      return 0
    })
    for (const child of kids) {
      if (!visited.has(child.to)) {
        queue.push({ id: child.to, depth: depth + 1 })
      }
    }
  }

  // Add unvisited nodes at the bottom
  let maxDepth = Math.max(...Object.values(nodeDepth), 0)
  for (const n of apiNodes) {
    if (!visited.has(n.id)) {
      maxDepth++
      nodeDepth[n.id] = maxDepth
    }
  }

  // Group nodes by depth
  const depthGroups = {}
  for (const [id, depth] of Object.entries(nodeDepth)) {
    if (!depthGroups[depth]) depthGroups[depth] = []
    depthGroups[depth].push(id)
  }

  // Assign positions — center each depth row
  for (const [depth, ids] of Object.entries(depthGroups)) {
    const d = Number(depth)
    const count = ids.length
    ids.forEach((id, idx) => {
      const totalWidth = (count - 1) * X_OFFSET
      positions[id] = {
        x: X_CENTER - totalWidth / 2 + idx * X_OFFSET,
        y: Y_START + d * Y_STEP,
      }
    })
  }

  return positions
}

/**
 * Convert backend API workflow to React Flow nodes + edges.
 */
export function apiToReactFlow(workflow) {
  const apiNodes = workflow.nodes || []
  const apiEdges = workflow.edges || []
  const isSystem = workflow.tenant_id === '__system__'

  // Check if nodes have stored positions (future: store in metadata)
  const positions = autoLayout(apiNodes, apiEdges)

  const rfNodes = apiNodes.map(n => {
    const data = {
      nodeType: n.type,
      label: n.label || n.phase_label || n.id,
      task_type: n.task_type || '',
      description: n.description || '',
      agent_selection: n.agent_selection || '',
      agent_type: n.agent_type || '',
      phase_label: n.phase_label || '',
      _isSystem: isSystem,
    }
    if (n.can_delegate === true) data.can_delegate = true
    if (n.type === 'a2a_agent') {
      data.server_id = n.server_id || ''
      data.reads = copyA2aSpecList(n, 'reads')
      data.writes = copyA2aSpecList(n, 'writes')
      data.a2a_poll_interval_seconds = n.a2a_poll_interval_seconds ?? 1
      data.a2a_task_timeout_seconds = n.a2a_task_timeout_seconds ?? 3600
    } else {
      copyContractKeyList(data, n, 'reads')
      copyContractKeyList(data, n, 'writes')
      copyContractKeyList(data, n, 'show_keys')
      copyMaxRetries(data, n)
      copyMaxRejectRetries(data, n)
      if (n.reviewers != null) data.reviewers = n.reviewers
      if (n.output_schema != null) data.output_schema = n.output_schema
      if (Array.isArray(n.checks) && n.checks.length > 0) data.checks = n.checks
      if (n.interaction_schema != null) data.interaction_schema = n.interaction_schema
      if (n.type === 'tool') {
        for (const key of TOOL_NODE_FIELDS) data[key] = n[key] || ''
      }
      if (n.type === 'map') {
        for (const key of MAP_NODE_TEXT_FIELDS) data[key] = n[key] || ''
        for (const key of MAP_NODE_NUMBER_FIELDS) if (n[key] != null) data[key] = n[key]
        if (Array.isArray(n.item_checks)) data.item_checks = n.item_checks
      }
    }

    return {
      id: n.id,
      type: NODE_TYPE_MAP[n.type] || 'phaseNode',
      position: positions[n.id] || { x: 400, y: 60 },
      data,
    }
  })

  const rfEdges = apiEdges.map((e, idx) => {
    const condition = e.condition || null
    const source = e.from || e.source
    const target = e.to || e.target

    return {
      id: `e-${source}-${target}-${idx}`,
      source,
      target,
      sourceHandle: condition === 'approved' || condition === 'rejected' ? condition : undefined,
      type: condition ? 'conditionalEdge' : 'default',
      data: { condition: condition || 'default' },
      animated: condition === 'rejected',
    }
  })

  return { nodes: rfNodes, edges: rfEdges }
}

/**
 * Apply a form-level data patch to a wire node.
 * Replicates the intentional-drop rules from the old reactFlowToApi, but as a
 * targeted patch so that unknown wire fields are never touched.
 */
export function applyNodeFormPatch(wireNode, formPatch) {
  const result = { ...wireNode }

  // Simple string fields: falsy → delete key
  for (const key of ['task_type', 'description', 'agent_selection', 'agent_type', 'server_id', ...TOOL_NODE_FIELDS, ...MAP_NODE_TEXT_FIELDS]) {
    if (!hasOwn(formPatch, key)) continue
    if (formPatch[key]) result[key] = formPatch[key]
    else delete result[key]
  }

  // phase_label: falsy → delete; when set on phase node, also drop label (phase_label is the name)
  if (hasOwn(formPatch, 'phase_label')) {
    if (formPatch.phase_label) {
      result.phase_label = formPatch.phase_label
      if (wireNode.type === 'phase') delete result.label
    } else {
      delete result.phase_label
    }
  }

  // label: on phase nodes persisted only when there's no phase_label (legacy support)
  if (hasOwn(formPatch, 'label')) {
    const hasPhaseLabelNow = !!(hasOwn(formPatch, 'phase_label') ? formPatch.phase_label : result.phase_label)
    const isPhase = wireNode.type === 'phase'
    if (isPhase && hasPhaseLabelNow) {
      delete result.label
    } else if (formPatch.label && formPatch.label !== wireNode.id) {
      result.label = formPatch.label
    } else {
      delete result.label
    }
  }

  // can_delegate: false / absent → delete (default is false, omit to keep wire clean)
  if (hasOwn(formPatch, 'can_delegate')) {
    if (formPatch.can_delegate === true) result.can_delegate = true
    else delete result.can_delegate
  }

  // Contract key lists (string arrays for phase; structured dicts for a2a)
  for (const key of ['reads', 'writes', 'show_keys']) {
    if (!hasOwn(formPatch, key)) continue
    if (wireNode.type === 'a2a_agent' && (key === 'reads' || key === 'writes')) {
      result[key] = Array.isArray(formPatch[key]) ? formPatch[key] : []
    } else {
      result[key] = normalizeContractKeyList(formPatch[key])
    }
  }

  // max_retries: falsy → delete
  if (hasOwn(formPatch, 'max_retries')) {
    if (formPatch.max_retries == null || formPatch.max_retries === '') {
      delete result.max_retries
    } else {
      const parsed = Number(formPatch.max_retries)
      if (Number.isInteger(parsed)) result.max_retries = parsed
    }
  }

  // Map settings: empty → delete so the backend default applies; a non-integer
  // is kept for the backend to reject, as the editor already flags it.
  for (const key of MAP_NODE_NUMBER_FIELDS) {
    if (!hasOwn(formPatch, key)) continue
    if (formPatch[key] == null || formPatch[key] === '') {
      delete result[key]
      continue
    }
    const parsed = Number(formPatch[key])
    result[key] = Number.isInteger(parsed) ? parsed : formPatch[key]
  }

  // max_reject_retries: falsy → delete (validator nodes only, same rules as max_retries)
  if (hasOwn(formPatch, 'max_reject_retries')) {
    if (formPatch.max_reject_retries == null || formPatch.max_reject_retries === '') {
      delete result.max_reject_retries
    } else {
      const parsed = Number(formPatch.max_reject_retries)
      if (Number.isInteger(parsed)) result.max_reject_retries = parsed
    }
  }

  // An empty A2A polling field falls back to the backend default. Invalid
  // values are preserved for the backend validation path; the editor blocks
  // them earlier with its matching positive-number validation.
  for (const key of ['a2a_poll_interval_seconds', 'a2a_task_timeout_seconds']) {
    if (!hasOwn(formPatch, key)) continue
    if (formPatch[key] == null || formPatch[key] === '') {
      delete result[key]
      continue
    }
    const parsed = Number(formPatch[key])
    result[key] = Number.isFinite(parsed) ? parsed : formPatch[key]
  }

  // JSON object fields: null → delete
  for (const key of ['reviewers', 'output_schema', 'interaction_schema']) {
    if (!hasOwn(formPatch, key)) continue
    if (formPatch[key] != null) result[key] = formPatch[key]
    else delete result[key]
  }

  for (const key of ['checks', 'item_checks']) {
    if (!hasOwn(formPatch, key)) continue
    if (Array.isArray(formPatch[key]) && formPatch[key].length > 0) {
      result[key] = formPatch[key]
    } else {
      delete result[key]
    }
  }

  return result
}

/**
 * Generate a unique node ID for a given type.
 */
export function generateNodeId(type, existingNodes) {
  const existing = new Set(existingNodes.map(n => n.id))
  let counter = 1
  let id = `${type}_${counter}`
  while (existing.has(id)) {
    counter++
    id = `${type}_${counter}`
  }
  return id
}

/**
 * Create a new React Flow node for a given backend type at the given position.
 */
export function createNewNode(backendType, position, existingNodes) {
  const id = generateNodeId(backendType, existingNodes)
  const data = {
    nodeType: backendType,
    label: id,
    task_type: '',
    description: '',
    agent_selection: { phase: 'auction', map: 'direct' }[backendType] || '',
    agent_type: '',
    phase_label: '',
    _isSystem: false,
  }
  if (backendType === 'a2a_agent') {
    data.server_id = ''
    data.reads = []
    data.writes = []
    data.a2a_poll_interval_seconds = 1
    data.a2a_task_timeout_seconds = 3600
  }
  if (backendType === 'tool') {
    for (const key of TOOL_NODE_FIELDS) data[key] = ''
    data.writes = []
  }
  if (backendType === 'map') {
    for (const key of MAP_NODE_TEXT_FIELDS) data[key] = ''
    data.writes = []
  }
  return {
    id,
    type: NODE_TYPE_MAP[backendType] || 'phaseNode',
    position,
    data,
  }
}

/**
 * Create a default new workflow with start + end nodes.
 */
export function createEmptyWorkflow() {
  const nodes = [
    { id: 'start', type: 'startNode', position: { x: 400, y: 60 }, data: { nodeType: 'start', label: 'Start', _isSystem: false } },
    { id: 'end', type: 'endNode', position: { x: 400, y: 300 }, data: { nodeType: 'end', label: 'End', _isSystem: false } },
  ]
  const edges = [
    { id: 'e-start-end-0', source: 'start', target: 'end', type: 'default', data: { condition: 'default' } },
  ]
  return { nodes, edges }
}
