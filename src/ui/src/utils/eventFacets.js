/**
 * Pure, React-free classifiers and facet logic for the Events tab filter.
 * Sits on top of filterEventsForDisplay() output (which may include synthetic
 * `collapsed_thought` items) — every function tolerates a missing `data`.
 *
 * The Events tab log carries ~70% telemetry (per-turn token usage, capture
 * markers, the raw start/executing sub-events behind each tool call). These are
 * hidden by default and revealed by the Raw toggle; nothing is dropped.
 */

// Low-signal, high-volume event types hidden in the default (signal) view.
// `.delta` chunks are stripped before the log by filterEventsForDisplay, but a
// live one can still arrive, so the suffix is covered here too.
export const TELE_TYPES = new Set([
  'agent.streaming.usage',
  'agent.invocation.captured',
  'agent.streaming.tool_call.start',
  'agent.streaming.tool_call.executing',
  'tool_started',
  'tool_executed',
  'snapshot_created',
])

export function isTelemetryType(type) {
  if (!type) return false
  return TELE_TYPES.has(type) || type.endsWith('.delta')
}

export function categoryOf(type) {
  const t = type || ''
  if (t.startsWith('agent.streaming.tool_call') || t === 'tool_started' || t === 'tool_executed') return 'Tool'
  if (t.startsWith('agent.delegation')) return 'Delegation'
  if (t.startsWith('agent.')) return 'Agent'
  if (t.startsWith('phase.')) return 'Phase'
  if (t.startsWith('task_')) return 'Task'
  if (t.startsWith('auction')) return 'Auction'
  if (t.startsWith('approval')) return 'Approval'
  if (t.startsWith('project')) return 'Project'
  if (t.startsWith('container')) return 'Container'
  if (t === 'snapshot_created') return 'Snapshot'
  if (t.startsWith('deploy')) return 'Deploy'
  if (t === 'collapsed_thought') return 'Thought'
  return 'Other'
}

// A failed tool call or task keeps its normal type (`…tool_call.result`,
// `tool_executed`, `execution_task_finished`) — the failure lives in the payload
// as data.status / data.result.status ('error'|'failed'), not a top-level
// data.error. Read both, so the Status facet and the row badge agree. Single
// source of truth shared with EventPrimaryLine — the two drifting is the bug
// this guards against.
export function isFailureEvent(type, data) {
  const t = type || ''
  // A plugin.marker's `data.error` is the overflow *trigger* that prompted a
  // recovery fold, not an outcome — a successful compaction carries it too. Real
  // plugin failures are the separate plugin.error type. Mirrors EventCard.hasError.
  if (t === 'plugin.marker') return false
  const d = data || {}
  const bad = (v) => v === 'error' || v === 'failed'
  return Boolean(d.error) || bad(d.status) || bad(d.result?.status) ||
    t.endsWith('.error') || t.endsWith('.failed') || t.endsWith('_failed') ||
    t.endsWith('rejected') || t.endsWith('timeout')
}

// success | error | run | info — the value behind the Status facet and status:
// search. Row colour/icon are EventCard's own (getEventStatus/hasError); this feeds neither.
// Failure is checked first so a payload failure wins over a stray status:completed.
export function statusOf(event) {
  const t = event?.type || ''
  const d = event?.data || {}
  if (isFailureEvent(t, d)) return 'error'
  if (d?.result?.status === 'success' || d.status === 'completed' ||
      t.endsWith('.completed') || t.endsWith('_completed') || t === 'project_completed') return 'success'
  if (t.endsWith('.started') || t.endsWith('_started') || t === 'task_attempt' ||
      t === 'container_created' || t === 'project_started') return 'run'
  return 'info'
}

// "__default____research_worker@proj-id" -> "research_worker"; ""/null -> "agent".
export function cleanAgentName(id) {
  let s = String(id || '')
  s = s.split('@')[0]
  const i = s.lastIndexOf('__')
  if (i >= 0) s = s.slice(i + 2)
  return s || 'agent'
}

// The acting agent's raw id. Delegation events carry no `agent_id`; the actor is
// the delegating parent, so fall back to it (the child is surfaced separately).
function actorIdOf(data) {
  return data.agent_id || data.parent_agent || ''
}

// Tool name lives on `data.name` for the streaming tool_call.* events and on
// `data.tool_id` for the flat tool_executed event; `data.tool` covers older emits.
function toolOf(data) {
  return data.name || data.tool || data.tool_id || ''
}

// Per-string and total caps on the haystack. Rebuilt once per annotate pass (not
// per keystroke); the caps bound that work and stop one huge field — a base64
// preview, a giant tool-arguments blob — from crowding out the short ids that come
// earlier in the object. STRING_CAP keeps parity with the old 2000-char content cap.
const SEARCH_STRING_CAP = 2000
const SEARCH_TEXT_CAP = 4000
const SEARCH_MAX_DEPTH = 8

// Event-`data` keys whose values are high-volume, non-semantic telemetry: token
// counts, timestamps, ordinal counters, byte/line tallies, vector arrays. Indexing
// them only bloats the haystack and makes a digit run match unrelated rows. Every
// OTHER field is walked, so a newly-added backend field (a call_id, a result note)
// becomes searchable with no edit here — the maintenance trap the curated list had.
const SEARCH_SKIP_KEYS = new Set([
  'usage', 'token_counts', 'prompt_tokens', 'completion_tokens', 'total_tokens',
  'timestamp', 'created_at', 'updated_at', 'started_at', 'finished_at',
  'sequence', 'turn_index', 'round',
  'size_bytes', 'scanned_bytes', 'lines_scanned',
  'embedding', 'vector',
])

// Depth-first collect of string/number leaf VALUES (never keys) into `out`, skipping
// SEARCH_SKIP_KEYS and stopping at the total budget. Values-not-keys is the point: a
// raw JSON.stringify would let "status" or "name" match every row.
function collectSearchValues(node, out, budget, depth) {
  if (node == null || depth > SEARCH_MAX_DEPTH || budget.n >= SEARCH_TEXT_CAP) return
  const t = typeof node
  if (t === 'string') {
    const s = node.length > SEARCH_STRING_CAP ? node.slice(0, SEARCH_STRING_CAP) : node
    out.push(s)
    budget.n += s.length + 1
  } else if (t === 'number') {
    const s = String(node)
    out.push(s)
    budget.n += s.length + 1
  } else if (Array.isArray(node)) {
    for (const v of node) {
      if (budget.n >= SEARCH_TEXT_CAP) break
      collectSearchValues(v, out, budget, depth + 1)
    }
  } else if (t === 'object') {
    for (const k of Object.keys(node)) {
      if (budget.n >= SEARCH_TEXT_CAP) break
      if (SEARCH_SKIP_KEYS.has(k)) continue
      collectSearchValues(node[k], out, budget, depth + 1)
    }
  }
}

function buildSearchText(event, data, agentLabel, agentId, tool, phase, cat) {
  // Derived / cross-joined identity first — cleaned agent id, display label (from the
  // run-scoped map, absent on the raw event), resolved tool, carried phase, category.
  // The walk can't reproduce these from `data`. Then every leaf value in `data`, then
  // top-level `event.content` (synthetic collapsed_thought carries content there, and
  // has no `data`).
  const out = [event.type, agentLabel, agentId, tool, phase, cat]
  const budget = { n: out.join(' ').length }
  collectSearchValues(data, out, budget, 0)
  collectSearchValues(event.content, out, budget, 0)
  return out.filter(Boolean).join(' ').toLowerCase()
}

/**
 * One ordered pass over filterEventsForDisplay() output. Returns a shallow copy
 * of each event with derived `_`-prefixed fields for facets/search/rendering.
 * A run-scoped agent-id -> display-name map is built first so every event of an
 * agent shows one label, even the ones (tool_call.result, delegation, text.done)
 * that omit `agent_display_name` — otherwise the Agent facet splits one agent
 * into "Provisioning Assessor" and "provisioning_assessor".
 */
export function annotateEvents(events) {
  const arr = Array.isArray(events) ? events : []

  const labelById = new Map()
  for (const e of arr) {
    const raw = e?.data?.agent_id
    const disp = e?.data?.agent_display_name
    if (raw && disp) labelById.set(cleanAgentName(raw), disp)
  }

  let running = ''
  return arr.map((e) => {
    const type = e?.type || ''
    const data = e?.data || {}

    let phase
    if (type.startsWith('phase.')) {
      const p = type.split('.')[1] || ''
      if (p) running = p
      phase = p || running
    } else if (data.phase) {
      running = data.phase
      phase = data.phase
    } else {
      phase = running
    }

    const rawId = actorIdOf(data)
    const agentId = rawId ? cleanAgentName(rawId) : ''
    const agentLabel = agentId ? (labelById.get(agentId) || agentId) : ''
    const tool = toolOf(data)
    const cat = categoryOf(type)

    return {
      ...e,
      _cat: cat,
      _status: statusOf(e),
      _agentId: agentId,
      _agentLabel: agentLabel,
      _tool: tool,
      _phase: phase,
      _tele: isTelemetryType(type),
      _search: buildSearchText(e, data, agentLabel, agentId, tool, phase, cat),
    }
  })
}

export const STATUS_LABEL = { success: 'success', error: 'error', run: 'running', info: 'info' }

// Search tokens over event-derived data plus fields eventEnrichment joins from
// outside the stream: `model` (agent_llm_calls) and `server`/`address` (configs).
const TOKEN_FIELDS = new Set(['agent', 'tool', 'status', 'type', 'phase', 'category', 'model', 'server', 'address'])

// "tool:uro status:error deficit" -> {terms:['deficit'], tokens:[{field,value}...]}.
// An unknown field (e.g. nope:glm) is kept as a plain term, not a token.
export function parseQuery(query) {
  const parts = String(query || '').trim().split(/\s+/).filter(Boolean)
  const terms = []
  const tokens = []
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z]+):(.+)$/)
    if (m && TOKEN_FIELDS.has(m[1].toLowerCase())) {
      tokens.push({ field: m[1].toLowerCase(), value: m[2] })
    } else {
      terms.push(p)
    }
  }
  return { terms, tokens }
}

function tokenHaystack(ev, field) {
  switch (field) {
    case 'agent': return `${ev._agentLabel} ${ev._agentId}`
    case 'tool': return ev._tool
    case 'status': return `${ev._status} ${STATUS_LABEL[ev._status] || ''}`
    case 'type': return ev.type || ''
    case 'phase': return ev._phase
    case 'category': return ev._cat
    case 'model': return ev._model || ''
    case 'server': return ev._server || ''
    case 'address': return ev._address || ''
    default: return ''
  }
}

// AND across every term and token; a term hits the combined `_search` text, a
// token only its own field. Call with the output of parseQuery.
export function eventMatchesSearch(ev, parsed) {
  const { terms, tokens } = parsed
  for (const t of terms) {
    if (!ev._search.includes(t.toLowerCase())) return false
  }
  for (const { field, value } of tokens) {
    const hay = String(tokenHaystack(ev, field) || '').toLowerCase()
    if (!hay.includes(value.replace(/\*/g, '').toLowerCase())) return false
  }
  return true
}

// Facets over event-derived fields plus data joined by eventEnrichment: Model from
// agent_llm_calls, Server from MCP/A2A configs. A row with no joined value
// contributes nothing to that facet.
export const DEFAULT_FACETS = [
  { key: 'category', label: 'Category', field: (e) => [e._cat] },
  { key: 'agent', label: 'Agent', field: (e) => (e._agentLabel ? [e._agentLabel] : []) },
  { key: 'tool', label: 'Tool', field: (e) => (e._tool ? [e._tool] : []), mono: true },
  { key: 'model', label: 'Model', field: (e) => (e._model ? [e._model] : []), mono: true },
  { key: 'server', label: 'Server', field: (e) => (e._server ? [e._server] : []), mono: true },
  { key: 'phase', label: 'Phase', field: (e) => (e._phase ? [e._phase] : []) },
  { key: 'status', label: 'Status', field: (e) => [e._status] },
]

function passLevel(ev, level) {
  return level === 'raw' || !ev._tele
}

// AND across facets, OR within one. `skipKey` drops one facet so its own
// selection doesn't shrink its own option counts (you can always widen it).
function passFacets(ev, selected, facets, skipKey) {
  for (const f of facets) {
    if (f.key === skipKey) continue
    const s = selected[f.key]
    if (!s || s.size === 0) continue
    if (!f.field(ev).some((v) => s.has(v))) return false
  }
  return true
}

/**
 * The filtered rows plus, per facet, the option->count map a user sees in the
 * dropdown. Each facet's counts are computed over the set passing level +
 * search + every OTHER facet, so a count is exactly what selecting it yields.
 * `teleHidden` is how many telemetry rows the signal view is holding back under
 * the current search/facets (0 in raw).
 */
export function computeFacetView(events, { level = 'signal', query = '', selected = {}, facets = DEFAULT_FACETS } = {}) {
  const arr = Array.isArray(events) ? events : []
  const parsed = parseQuery(query)
  const searchOk = (ev) => eventMatchesSearch(ev, parsed)

  const filtered = arr.filter(
    (ev) => passLevel(ev, level) && searchOk(ev) && passFacets(ev, selected, facets, null),
  )

  const counts = {}
  for (const f of facets) {
    const m = new Map()
    for (const ev of arr) {
      if (!passLevel(ev, level) || !searchOk(ev) || !passFacets(ev, selected, facets, f.key)) continue
      for (const v of f.field(ev)) m.set(v, (m.get(v) || 0) + 1)
    }
    counts[f.key] = m
  }

  const teleHidden = level === 'signal'
    ? arr.filter((ev) => ev._tele && searchOk(ev) && passFacets(ev, selected, facets, null)).length
    : 0

  return { filtered, counts, teleHidden }
}
