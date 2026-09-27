/**
 * ConcurrencyDebugPanel
 *
 * DEBUG-ONLY instrumentation. Watches the SSE stream for thinking activity
 * and surfaces a red banner the moment two agents are streaming "thinking"
 * deltas concurrently for the same project — a state we currently believe
 * should never happen (orchestration is supposed to be sequential).
 *
 * Why this exists:
 *   The user reported what looks like overlapping live-thinking content in
 *   LiveActivity. We do NOT yet know whether the cause is
 *     (a) the backend genuinely opening concurrent streams,
 *     (b) an orphaned stream from a prior step still emitting deltas, or
 *     (c) a UI rendering bug interleaving sequential events.
 *   Without instrumentation we can't tell which. This panel does not change
 *   any rendering — it only observes events and produces evidence.
 *
 * What it does:
 *   - Builds a per-agent live state from agent.streaming.thinking.{delta,done}
 *     events (and considers agent.streaming.text.done / .terminated as the
 *     "agent is no longer thinking" signal).
 *   - When >=2 agents are simultaneously in the "streaming thinking" state,
 *     OR when a backend agent.streaming.concurrency_warning event arrives,
 *     it flips red, console.warn's the snapshot, and stores an "incident".
 *   - Exposes a "Copy diagnostic bundle" button that produces a single JSON
 *     blob of state + recent thinking events + backend warnings — paste this
 *     back to the developer to root-cause the overlap.
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { AlertTriangle, Copy, ChevronDown, ChevronRight, Activity } from 'lucide-react'

function formatAgentName(agentId) {
  if (!agentId) return 'unknown'
  const base = agentId.split('@')[0].replace(/_\d+$/, '')
  return base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Parse the backend "<float>-<seq>" timestamp; fall back to client-side time.
function eventEpochMs(e) {
  const ts = e?.data?.timestamp
  if (typeof ts === 'string') {
    const head = ts.split('-')[0]
    const f = parseFloat(head)
    if (Number.isFinite(f)) return f * 1000
  }
  if (e?.timestamp instanceof Date) return e.timestamp.getTime()
  if (e?.timestamp) {
    const t = new Date(e.timestamp).getTime()
    if (Number.isFinite(t)) return t
  }
  return Date.now()
}

const STREAMING_TYPES = new Set([
  'agent.streaming.thinking.delta',
  'agent.streaming.thinking.done',
  'agent.streaming.text.delta',
  'agent.streaming.text.done',
  'agent.streaming.terminated',
  'agent.streaming.concurrency_warning',
  'agent.validation.timeout',
])

export default function ConcurrencyDebugPanel({ recentEvents = [], projectId }) {
  // agentStates: agent_id -> {
  //   status: 'thinking' | 'idle',
  //   firstDeltaAt, lastDeltaAt, deltaCount, charCount,
  //   doneAt, phase, lastStreamId
  // }
  const [agentStates, setAgentStates] = useState({})
  const [incidents, setIncidents] = useState([])  // [{at, activeAgents, kind, raw}]
  const [backendWarnings, setBackendWarnings] = useState([])  // raw backend concurrency events
  const [expanded, setExpanded] = useState(false)
  const processedRef = useRef(new Set())
  const lastIncidentSigRef = useRef('')

  useEffect(() => {
    if (!recentEvents?.length) return

    setAgentStates(prevStates => {
      const states = { ...prevStates }
      const newIncidents = []
      const newBackendWarnings = []

      for (const e of recentEvents) {
        const type = e?.type
        if (!type || !STREAMING_TYPES.has(type)) continue

        // Per-event dedup so React's strict-mode double-invoke doesn't
        // double-count deltas. ID derived from full event signature.
        const id = `${type}|${e?.data?.timestamp || e?.timestamp || ''}|${e?.data?.agent_id || ''}|${(e?.data?.content || '').length}`
        if (processedRef.current.has(id)) continue
        processedRef.current.add(id)

        const agentId = e?.data?.agent_id || null
        const phase = e?.data?.phase || null
        const at = eventEpochMs(e)

        if (type === 'agent.streaming.thinking.delta' && agentId) {
          const prev = states[agentId] || {}
          const wasThinking = prev.status === 'thinking'
          states[agentId] = {
            ...prev,
            status: 'thinking',
            firstDeltaAt: wasThinking ? prev.firstDeltaAt : at,
            lastDeltaAt: at,
            deltaCount: (prev.deltaCount || 0) + 1,
            charCount: (prev.charCount || 0) + (e?.data?.content || '').length,
            phase: phase || prev.phase,
          }
          // Detect overlap: >1 agent in 'thinking' state at this moment.
          const thinking = Object.entries(states).filter(([, s]) => s.status === 'thinking').map(([aid, s]) => ({ agent_id: aid, ...s }))
          if (thinking.length > 1) {
            const sig = thinking.map(s => s.agent_id).sort().join('|')
            if (sig !== lastIncidentSigRef.current) {
              lastIncidentSigRef.current = sig
              // "Expected" overlap = every active agent is in the bidding
              // phase. auction.py:498 runs bid_on_task via asyncio.gather, so
              // multiple agents bidding simultaneously is correct behavior.
              // Any other shape (mixed phases, post-auction work overlapping
              // with an old bid stream, etc.) indicates an orphan stream and
              // is a real bug — see the orphan-cancellation root cause.
              const expected = thinking.every(s => s.phase === 'bidding')
              const incident = {
                at: new Date(at).toISOString(),
                kind: 'ui_detected',
                expected,
                triggered_by: { type, agent_id: agentId, phase },
                active_agents: thinking,
              }
              newIncidents.push(incident)
              if (!expected) {
                try {
                  // Stringify the payload so the console line is grep/copy-friendly.
                  // Object args render collapsed in DevTools and force a manual expand.
                  console.warn('[CONCURRENCY-UI] unexpected overlap ' + JSON.stringify(incident))
                } catch {}
              }
            }
          }
        } else if (type === 'agent.streaming.thinking.done' && agentId) {
          const prev = states[agentId] || {}
          states[agentId] = {
            ...prev,
            status: 'idle',
            doneAt: at,
            phase: phase || prev.phase,
          }
          // The agent that just finished is no longer thinking — clear the
          // overlap signature so the *next* genuine overlap re-fires.
          lastIncidentSigRef.current = ''
        } else if ((type === 'agent.streaming.text.delta' || type === 'agent.streaming.text.done') && agentId) {
          // Once an agent transitions to text emission, it's also no longer
          // in the "thinking" state.
          const prev = states[agentId] || {}
          if (prev.status === 'thinking') {
            states[agentId] = { ...prev, status: 'idle', doneAt: at }
            lastIncidentSigRef.current = ''
          }
        } else if (type === 'agent.streaming.terminated' && agentId) {
          const prev = states[agentId] || {}
          states[agentId] = { ...prev, status: 'idle', terminatedAt: at, terminatedReason: e?.data?.reason }
          lastIncidentSigRef.current = ''
        } else if (type === 'agent.streaming.concurrency_warning') {
          const data = e?.data || {}
          // Same "expected" rule as the UI-side detector — every stream in
          // the overlap (the new one and all existing ones) is in the
          // bidding phase. Anything else is an orphan stream.
          const expected = data.new_stream?.phase === 'bidding'
            && Array.isArray(data.existing_streams)
            && data.existing_streams.every(s => s.phase === 'bidding')
          newBackendWarnings.push({
            at: new Date(at).toISOString(),
            expected,
            data,
          })
          if (!expected) {
            try {
              console.warn('[CONCURRENCY-BACKEND] unexpected concurrency ' + JSON.stringify(data))
            } catch {}
          }
        }
      }

      if (newIncidents.length) {
        setIncidents(prev => [...prev, ...newIncidents].slice(-50))
      }
      if (newBackendWarnings.length) {
        setBackendWarnings(prev => [...prev, ...newBackendWarnings].slice(-50))
      }
      return states
    })

    // Trim processed-id set to bound memory.
    if (processedRef.current.size > 5000) {
      const arr = Array.from(processedRef.current)
      processedRef.current = new Set(arr.slice(-2000))
    }
  }, [recentEvents])

  const activeAgents = useMemo(
    () => Object.entries(agentStates).filter(([, s]) => s.status === 'thinking').map(([aid, s]) => ({ agent_id: aid, ...s })),
    [agentStates]
  )

  // Split incidents/warnings by whether they represent expected parallel
  // bidding (intentional, see auction.py) or unexpected overlap (orphan
  // streams, mixed phases, etc.). The header only goes red for unexpected.
  const unexpectedIncidents = useMemo(() => incidents.filter(i => !i.expected), [incidents])
  const expectedIncidents = useMemo(() => incidents.filter(i => i.expected), [incidents])
  const unexpectedBackendWarnings = useMemo(() => backendWarnings.filter(w => !w.expected), [backendWarnings])
  const expectedBackendWarnings = useMemo(() => backendWarnings.filter(w => w.expected), [backendWarnings])

  // Currently-thinking concurrency is also classifiable: if multiple agents
  // are thinking AND not all of them are bidding, that's unexpected even if
  // no incident has been recorded yet.
  const activeIsUnexpected = activeAgents.length > 1 && !activeAgents.every(a => a.phase === 'bidding')

  const hasUnexpected = unexpectedIncidents.length > 0
    || unexpectedBackendWarnings.length > 0
    || activeIsUnexpected

  // Hide entirely when there's no streaming activity at all and no incidents.
  if (activeAgents.length === 0 && incidents.length === 0 && backendWarnings.length === 0) {
    return null
  }

  const copyBundle = async () => {
    const bundle = {
      project_id: projectId,
      captured_at: new Date().toISOString(),
      ui_active_agents: activeAgents,
      ui_agent_states: agentStates,
      ui_incidents: incidents,
      backend_concurrency_warnings: backendWarnings,
      // Last 200 streaming-related events, lightly projected so the bundle
      // stays paste-able without dumping every delta's full content.
      recent_streaming_events: (recentEvents || [])
        .filter(e => STREAMING_TYPES.has(e?.type))
        .slice(-200)
        .map(e => ({
          type: e.type,
          timestamp: e?.data?.timestamp || (e?.timestamp instanceof Date ? e.timestamp.toISOString() : e?.timestamp) || null,
          agent_id: e?.data?.agent_id || null,
          phase: e?.data?.phase || null,
          stream_id: e?.data?.stream_id || null,
          content_len: (e?.data?.content || '').length,
          // For thinking.done include thinking_time so timing is visible.
          thinking_time: e?.data?.thinking_time ?? null,
          // Pass through the full payload of non-delta events (small enough).
          data: e?.type?.endsWith('.delta') ? undefined : e?.data,
        })),
    }
    const json = JSON.stringify(bundle, null, 2)
    try {
      await navigator.clipboard.writeText(json)
    } catch {
      // Fallback: open a textarea-style window.
      const w = window.open('', '_blank')
      if (w) {
        w.document.body.innerText = json
      }
    }
  }

  const containerCls = hasUnexpected
    ? 'border-red-500/60 bg-red-950/30'
    : 'border-slate-600/60 bg-slate-900/40'
  const iconCls = hasUnexpected ? 'text-red-400' : 'text-slate-400'
  const HeaderIcon = hasUnexpected ? AlertTriangle : Activity

  // Header label: red banner only fires when we're seeing actual orphans /
  // mixed-phase concurrency. Parallel bidders show as a quiet info line.
  const headerLabel = (() => {
    if (hasUnexpected) {
      return `Unexpected concurrency — ${activeAgents.length} active, ${unexpectedIncidents.length} ui incident(s), ${unexpectedBackendWarnings.length} backend warning(s)`
    }
    if (activeAgents.length > 1) {
      return `Parallel bidding — ${activeAgents.length} agents thinking`
    }
    if (expectedIncidents.length || expectedBackendWarnings.length) {
      return `Stream debug — ${activeAgents.length} active, ${expectedIncidents.length + expectedBackendWarnings.length} expected overlap(s)`
    }
    return `Stream debug — ${activeAgents.length} active`
  })()
  const headerTextCls = hasUnexpected ? 'text-red-300' : 'text-slate-300'

  return (
    <div className={`my-2 border rounded-lg ${containerCls} text-xs`}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <HeaderIcon className={`w-4 h-4 ${iconCls}`} />
          <span className={`font-mono uppercase tracking-wide ${headerTextCls}`}>
            {headerLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            role="button"
            tabIndex={0}
            onClick={(ev) => { ev.stopPropagation(); copyBundle() }}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.stopPropagation(); copyBundle() } }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 cursor-pointer"
            title="Copy diagnostic bundle (JSON) to clipboard"
          >
            <Copy className="w-3 h-3" />
            <span>Copy bundle</span>
          </span>
          {expanded ? <ChevronDown className={`w-4 h-4 ${iconCls}`} /> : <ChevronRight className={`w-4 h-4 ${iconCls}`} />}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {activeAgents.length > 0 && (
            <div>
              <div className="text-slate-400 mb-1">Active streams</div>
              <div className="space-y-1">
                {activeAgents.map(a => (
                  <div key={a.agent_id} className="font-mono text-slate-200 flex items-center gap-3">
                    <span className={activeIsUnexpected ? 'text-red-300' : 'text-emerald-300'}>●</span>
                    <span>{formatAgentName(a.agent_id)}</span>
                    <span className="text-slate-500">phase={String(a.phase ?? 'null')}</span>
                    <span className="text-slate-500">deltas={a.deltaCount ?? 0}</span>
                    <span className="text-slate-500">chars={a.charCount ?? 0}</span>
                    {a.firstDeltaAt && (
                      <span className="text-slate-500">elapsed={((Date.now() - a.firstDeltaAt) / 1000).toFixed(1)}s</span>
                    )}
                    <span className="text-slate-600">{a.agent_id}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {backendWarnings.length > 0 && (
            <div>
              <div className={`mb-1 ${unexpectedBackendWarnings.length ? 'text-red-300' : 'text-slate-400'}`}>
                Backend concurrency events ({backendWarnings.length}
                {unexpectedBackendWarnings.length > 0 ? `, ${unexpectedBackendWarnings.length} unexpected` : ''})
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {backendWarnings.slice(-10).map((w, i) => (
                  <div key={i} className="font-mono text-slate-300">
                    <span className={`mr-2 px-1 rounded text-[10px] ${w.expected ? 'bg-slate-700 text-slate-300' : 'bg-red-900 text-red-200'}`}>
                      {w.expected ? 'expected' : 'unexpected'}
                    </span>
                    <span className="text-slate-500">{w.at}</span>{' '}
                    <span>active_count={w.data?.active_count}</span>{' '}
                    <span>new={formatAgentName(w.data?.new_stream?.agent_id)} ({w.data?.new_stream?.phase ?? 'null'})</span>{' '}
                    <span className="text-slate-500">existing={(w.data?.existing_streams || []).map(s => `${formatAgentName(s.agent_id)}/${s.phase ?? 'null'}`).join(', ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {incidents.length > 0 && (
            <div>
              <div className={`mb-1 ${unexpectedIncidents.length ? 'text-red-300' : 'text-slate-400'}`}>
                UI-detected overlap incidents ({incidents.length}
                {unexpectedIncidents.length > 0 ? `, ${unexpectedIncidents.length} unexpected` : ''})
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {incidents.slice(-10).map((inc, i) => (
                  <div key={i} className="font-mono text-slate-300">
                    <span className={`mr-2 px-1 rounded text-[10px] ${inc.expected ? 'bg-slate-700 text-slate-300' : 'bg-red-900 text-red-200'}`}>
                      {inc.expected ? 'expected' : 'unexpected'}
                    </span>
                    <span className="text-slate-500">{inc.at}</span>{' '}
                    <span>agents={inc.active_agents.map(a => `${formatAgentName(a.agent_id)}/${a.phase ?? 'null'}`).join(', ')}</span>{' '}
                    <span className="text-slate-500">triggered_by={formatAgentName(inc.triggered_by?.agent_id)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-[10px] text-slate-500 italic">
            Hit "Copy bundle" while the issue is visible, then paste the JSON back to the developer.
            Bundle includes UI state, last 200 streaming-event headers, backend warnings, and detected incidents.
          </div>
        </div>
      )}
    </div>
  )
}
