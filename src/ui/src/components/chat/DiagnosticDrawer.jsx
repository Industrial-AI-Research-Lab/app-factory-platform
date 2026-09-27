/**
 * DiagnosticDrawer
 *
 * Right-side instrument drawer for inspecting a running (or completed) AppFactory
 * workflow. Internal devtool. Off by default; toggle with ⌘⇧D or the edge
 * handle. Lives at the page level (ExecutionMonitor.jsx) so it can overlay
 * everything, not just chat.
 *
 * Three vertical zones:
 *   1. Sticky title bar
 *   2. Sticky live header — current phase, active agent, model, stopwatch
 *   3. Sticky timeline strip — pip per phase
 *   4. Scrollable inspector — System prompt / Conversation / Tools / Streams /
 *      Events / Concurrency / Approvals. Each section click-to-expand.
 *
 * Sections that need a backend route (System prompt / Conversation / Tools)
 * render a "pending backend endpoint" placeholder for now; will populate when
 * GET /api/projects/:id/agents/:aid/context lands (piece 3 of the brief).
 *
 * Subsumes ConcurrencyDebugPanel.jsx — the concurrency-warning red banner is
 * gone from chat flow and lives here as a section that auto-expands when an
 * incident is detected and pulses the edge handle red when closed.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import {
  Activity, ChevronDown, ChevronRight, X, AlertTriangle,
  Cpu, MessageSquare, Wrench, Zap, FileText, ShieldCheck,
  Loader, Clock, Package, Copy, ExternalLink, RefreshCw
} from 'lucide-react'

const DRAWER_WIDTH = 420

function formatAgentName(agentId) {
  if (!agentId) return '—'
  const base = agentId.split('@')[0].replace(/_\d+$/, '')
  return base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function formatElapsed(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const totalS = Math.floor(ms / 1000)
  const m = Math.floor(totalS / 60)
  const s = totalS % 60
  if (m === 0) return `${(ms / 1000).toFixed(1)}s`
  return `${m}m ${String(s).padStart(2, '0')}s`
}

// Parse the backend "<float>-<seq>" timestamp; fall back to client-side time.
// Some event types (notably `phase.*.started`) carry a non-epoch timestamp
// in payload.timestamp — observed values around `5626.x-0`, which would
// resolve to year 1970 if multiplied by 1000. We bound the accepted range
// to [2017, 2096] before treating the parsed number as Unix epoch seconds.
function eventEpochMs(e) {
  const ts = e?.data?.timestamp
  if (typeof ts === 'string') {
    const head = ts.split('-')[0]
    const f = parseFloat(head)
    if (Number.isFinite(f) && f >= 1.5e9 && f <= 4e9) return f * 1000
  }
  if (e?.timestamp instanceof Date) return e.timestamp.getTime()
  if (e?.timestamp) {
    const t = new Date(e.timestamp).getTime()
    if (Number.isFinite(t) && t >= 1.5e12) return t
  }
  return 0
}

// Walk events to derive: current phase + when it started, latest active agent,
// configured model. Memoized at the call site against the events array.
function deriveLiveState(project, allEvents) {
  const phases = []
  let phaseStartMs = null
  let currentPhase = null
  let lastAgent = null

  for (const e of allEvents || []) {
    const t = e?.type || ''
    if (t.startsWith('phase.') && t.endsWith('.started')) {
      const phaseName = (e?.data?.phase || t.split('.')[1] || '').toString()
      phases.push({ name: phaseName, startMs: eventEpochMs(e), endMs: null, status: 'running' })
      phaseStartMs = eventEpochMs(e)
      currentPhase = phaseName
    } else if (t.startsWith('phase.') && (t.endsWith('.completed') || t.endsWith('.failed'))) {
      const phaseName = (e?.data?.phase || t.split('.')[1] || '').toString()
      const status = t.endsWith('.failed') ? 'failed' : 'complete'
      // Find the most recent matching running phase and close it.
      for (let i = phases.length - 1; i >= 0; i--) {
        if (phases[i].name === phaseName && phases[i].status === 'running') {
          phases[i].endMs = eventEpochMs(e)
          phases[i].status = status
          break
        }
      }
    }
    if (
      t === 'agent.streaming.thinking.delta' ||
      t === 'agent.streaming.text.delta' ||
      t === 'agent.streaming.thinking.done' ||
      t === 'agent.streaming.text.done'
    ) {
      if (e?.data?.agent_id) lastAgent = e.data.agent_id
    }
  }

  // Fall back to project state if events haven't surfaced phase yet
  if (!currentPhase && project?.current_phase) currentPhase = project.current_phase

  const projectStatus = (project?.status || '').toLowerCase()
  const projectDone = projectStatus === 'completed' || projectStatus === 'failed' || projectStatus === 'cancelled'

  const model = project?.model_id || project?.run_config?.model_id || null

  return {
    phases,
    currentPhase,
    phaseStartMs,
    activeAgent: lastAgent,
    model,
    projectStatus,
    projectDone,
  }
}

// Walk events to build the per-stream state.
//
// Streams are keyed on `*.done` events rather than `*.delta`, because some
// streams produce no observable deltas (auction-bid calls return parsed JSON
// without intermediate chunks; buffered providers like OpenRouter `:free` send
// one large chunk where the delta is barely distinguishable from the done).
// Each `thinking.done` / `text.done` is one logical stream completion. Delta
// events, if present, accumulate counts/chars onto the matching open stream
// keyed by agent_id + phase.
function deriveStreams(allEvents) {
  const closures = new Map() // key: stream_id || agent_id, recent wins
  const concurrencyIncidents = []
  const streams = []
  // While walking, track the currently-open delta accumulator per agent.
  // Closed on the next `*.done` for that agent.
  const openByAgent = new Map()

  for (const e of allEvents || []) {
    const t = e?.type || ''
    const aid = e?.data?.agent_id
    const sid = e?.data?.stream_id
    const tMs = eventEpochMs(e)

    if (t === 'agent.streaming.closed' || t === 'agent.streaming.terminated') {
      const key = sid || aid
      if (key) {
        const reason = t === 'agent.streaming.closed' ? 'closed' : (e?.data?.reason || 'cancelled')
        closures.set(key, {
          stream_id: sid || null,
          agent_id: aid || null,
          phase: e?.data?.phase || null,
          elapsedS: typeof e?.data?.elapsed === 'number' ? e.data.elapsed : null,
          reason,
          atMs: tMs,
        })
      }
      continue
    }

    if (t === 'agent.streaming.concurrency_warning') {
      concurrencyIncidents.push({
        atMs: tMs,
        newAgent: e?.data?.new_stream?.agent_id || null,
        newPhase: e?.data?.new_stream?.phase || null,
        existingCount: (e?.data?.existing_streams || []).length,
        activeCount: e?.data?.active_count || null,
      })
      continue
    }

    if (t === 'agent.streaming.thinking.delta' || t === 'agent.streaming.text.delta') {
      if (!aid) continue
      const cur = openByAgent.get(aid) || {
        agent_id: aid, phase: e?.data?.phase || null,
        firstMs: tMs, lastMs: tMs, deltaCount: 0,
        thinkingChars: 0, textChars: 0,
      }
      cur.lastMs = tMs
      cur.deltaCount += 1
      const content = e?.data?.content
      if (typeof content === 'string') {
        if (t === 'agent.streaming.thinking.delta') cur.thinkingChars += content.length
        else cur.textChars += content.length
      }
      openByAgent.set(aid, cur)
      continue
    }

    if (t === 'agent.streaming.thinking.done' || t === 'agent.streaming.text.done') {
      if (!aid) continue
      const cur = openByAgent.get(aid) || {
        agent_id: aid, phase: e?.data?.phase || null,
        firstMs: tMs, lastMs: tMs, deltaCount: 0,
        thinkingChars: 0, textChars: 0,
      }
      // Length-only fallback so a buffered done with no preceding delta still
      // shows a char count in the row.
      const content = e?.data?.content
      if (cur.deltaCount === 0 && typeof content === 'string') {
        if (t === 'agent.streaming.thinking.done') cur.thinkingChars = content.length
        else cur.textChars = content.length
        // No delta seen but a done arrived — treat as 1 logical chunk.
        cur.deltaCount = 1
      }
      cur.lastMs = tMs
      streams.push({
        key: `${aid}@${tMs}`,
        agent_id: aid,
        phase: cur.phase,
        kind: t === 'agent.streaming.thinking.done' ? 'thinking' : 'text',
        firstMs: cur.firstMs,
        lastMs: cur.lastMs,
        deltaCount: cur.deltaCount,
        thinkingChars: cur.thinkingChars,
        textChars: cur.textChars,
      })
      openByAgent.delete(aid)
      continue
    }
  }

  // Any agents with an open accumulator at the end of the walk → still streaming
  for (const cur of openByAgent.values()) {
    streams.push({
      key: `${cur.agent_id}@active`,
      ...cur,
      kind: 'streaming',
      open: true,
    })
  }

  // Match each finished stream with the nearest agent.streaming.closed within ±15s
  for (const s of streams) {
    if (s.open) continue
    let bestDelta = Infinity
    let closure = null
    for (const c of closures.values()) {
      if (!c.agent_id || c.agent_id !== s.agent_id) continue
      const delta = Math.abs(c.atMs - s.lastMs)
      if (delta > 15000) continue
      if (delta < bestDelta) { bestDelta = delta; closure = c }
    }
    s.wireElapsedMs = closure?.elapsedS != null ? Math.round(closure.elapsedS * 1000) : null
    s.closureReason = closure?.reason || null
    s.buffered = s.deltaCount === 1 && s.wireElapsedMs != null && s.wireElapsedMs >= 2000
    s.active = false
  }
  for (const s of streams) {
    if (s.open) {
      s.active = true
      s.wireElapsedMs = null
      s.closureReason = null
      s.buffered = false
    }
  }

  streams.sort((a, b) => (b.lastMs || 0) - (a.lastMs || 0))

  return {
    streams,
    activeCount: streams.filter(s => s.active).length,
    bufferedCount: streams.filter(s => s.buffered).length,
    concurrencyIncidents,
  }
}

function PhaseTimeline({ phases, currentPhase, projectDone, projectStatus }) {
  if (!phases.length) {
    return <div className="text-xs text-slate-500 italic">No phases yet</div>
  }
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      {phases.map((p, i) => {
        let glyph = '○'
        let cls = 'text-slate-600'
        if (p.status === 'complete') { glyph = '●'; cls = 'text-emerald-500/80' }
        else if (p.status === 'failed') { glyph = '✕'; cls = 'text-red-400' }
        else if (p.status === 'running') {
          glyph = '◐'
          cls = projectDone ? 'text-amber-400' : 'text-blue-400 animate-pulse'
        }
        const label = p.name.length > 8 ? p.name.slice(0, 8) : p.name
        return (
          <div key={`${p.name}-${i}`} className="flex flex-col items-center min-w-[42px]">
            <span className={`text-base leading-none ${cls}`}>{glyph}</span>
            <span className={`text-[10px] mt-0.5 truncate w-full text-center ${p.name === currentPhase ? 'text-slate-200' : 'text-slate-500'}`} title={p.name}>{label}</span>
          </div>
        )
      })}
    </div>
  )
}

function Section({ icon: Icon, title, count, accent, accentClass, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-slate-800/60">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-900/40 text-left"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
        <span className="text-[12px] text-slate-200 font-sans">{title}</span>
        {count != null && <span className="text-[11px] text-slate-500 font-mono">{count}</span>}
        {accent && (
          <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${accentClass || 'text-slate-400 border-slate-700'}`}>{accent}</span>
        )}
      </button>
      {open && <div className="px-3 pb-3 pt-1">{children}</div>}
    </div>
  )
}

function PlaceholderRow({ label }) {
  return (
    <div className="text-[11px] text-slate-500 italic font-sans">
      — {label} —
    </div>
  )
}

function EmptyOrError({ hasAgent, loading, error }) {
  if (!hasAgent) return <PlaceholderRow label="no active agent yet" />
  if (loading && !error) return <PlaceholderRow label="loading…" />
  if (error) return (
    <div className="text-[11px] text-red-400 font-sans break-words">
      {error}
    </div>
  )
  return null
}

function SystemPromptBody({ ctx, error, loading, hasAgent }) {
  const fallback = <EmptyOrError hasAgent={hasAgent} loading={loading} error={error} />
  if (!ctx) return fallback || <PlaceholderRow label="no data" />
  const text = ctx.system_prompt
  if (!text) {
    return (
      <div className="text-[11px] text-slate-500 italic font-sans">
        This agent builds its system prompt per-task from shared_context.
        No static prompt is stored on the instance.
      </div>
    )
  }
  return (
    <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto bg-slate-900/40 rounded p-2 border border-slate-800">
      {text}
    </pre>
  )
}

function ConversationBody({ ctx, error, loading, hasAgent }) {
  const fallback = <EmptyOrError hasAgent={hasAgent} loading={loading} error={error} />
  if (!ctx) return fallback || <PlaceholderRow label="no data" />
  const entries = Array.isArray(ctx.conversation_preview) ? ctx.conversation_preview : []
  if (!entries.length) return <PlaceholderRow label="conversation history empty" />
  return (
    <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
      {entries.map((e, i) => (
        <div key={i} className="bg-slate-900/40 rounded p-2 border border-slate-800/60">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
              {e.role || '?'}
            </span>
            {e.agent_id && (
              <span className="text-[10px] text-slate-500 font-mono truncate" title={e.agent_id}>
                {formatAgentName(e.agent_id)}
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap break-words">
            {e.content_preview}
          </div>
        </div>
      ))}
    </div>
  )
}

function ToolsBody({ ctx, error, loading, hasAgent }) {
  const fallback = <EmptyOrError hasAgent={hasAgent} loading={loading} error={error} />
  if (!ctx) return fallback || <PlaceholderRow label="no data" />
  const tools = Array.isArray(ctx.tools) ? ctx.tools : []
  if (!tools.length) return <PlaceholderRow label="no tools registered for this agent" />
  return (
    <div className="space-y-1 max-h-[260px] overflow-y-auto">
      {tools.map((t, i) => (
        <div key={t.id || i} className="flex items-start gap-2 text-[11px] font-mono">
          <span className="text-slate-200 shrink-0">{t.id || '—'}</span>
          {t.category && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">
              {t.category}
            </span>
          )}
          {t.description && (
            <span className="text-slate-500 truncate" title={t.description}>
              {t.description}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export default function DiagnosticDrawer({ open, setOpen, project, recentEvents, allEvents, pendingApproval }) {
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Esc closes (open/toggle shortcut is owned by parent so the same key works
  // even when focus is inside the chat input)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // Live stopwatch tick (only when open and project is running)
  useEffect(() => {
    if (!open) return
    const status = (project?.status || '').toLowerCase()
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return
    const id = setInterval(() => setNowTick(Date.now()), 500)
    return () => clearInterval(id)
  }, [open, project?.status])

  const live = useMemo(() => deriveLiveState(project, allEvents), [project, allEvents])
  const streamState = useMemo(() => deriveStreams(allEvents), [allEvents])

  const phaseElapsedMs = live.phaseStartMs ? (nowTick - live.phaseStartMs) : null
  const liveDotCls = live.projectDone
    ? (live.projectStatus === 'completed' ? 'bg-emerald-500' : 'bg-red-500')
    : 'bg-blue-400 animate-pulse'

  // Agent context fetch — populates System prompt / Conversation / Tools.
  // Re-fetches when drawer opens, when the active agent changes, or when
  // the user clicks the refresh button. Conversation grows over time so we
  // also poll lightly while drawer is open and project is running.
  const projectId = project?.id
  const activeAgent = live.activeAgent
  const agentContextUrl = (projectId && activeAgent)
    ? `/api/projects/${projectId}/agents/${encodeURIComponent(activeAgent)}/context`
    : null
  const [agentContext, setAgentContext] = useState(null)
  const [agentContextLoading, setAgentContextLoading] = useState(false)
  const [agentContextError, setAgentContextError] = useState(null)
  const [agentRefreshTick, setAgentRefreshTick] = useState(0)

  useEffect(() => {
    if (!open || !agentContextUrl) {
      setAgentContext(null)
      setAgentContextError(null)
      return
    }
    let cancelled = false
    setAgentContextLoading(true)
    setAgentContextError(null)
    fetch(agentContextUrl, { credentials: 'include' })
      .then(async r => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`
          try {
            const j = await r.json()
            if (j?.detail) detail = j.detail
          } catch (_) {}
          throw new Error(detail)
        }
        return r.json()
      })
      .then(data => { if (!cancelled) setAgentContext(data) })
      .catch(e => { if (!cancelled) setAgentContextError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setAgentContextLoading(false) })
    return () => { cancelled = true }
  }, [open, agentContextUrl, agentRefreshTick])

  useEffect(() => {
    if (!open || !agentContextUrl || live.projectDone) return
    const id = setInterval(() => setAgentRefreshTick(t => t + 1), 8000)
    return () => clearInterval(id)
  }, [open, agentContextUrl, live.projectDone])

  // Recent events (last 30)
  const recent30 = useMemo(() => {
    const arr = Array.isArray(recentEvents) ? recentEvents : []
    return arr.slice(-30).reverse()
  }, [recentEvents])

  // Concurrency pulse signal for the edge handle
  const concurrencyAlert = streamState.concurrencyIncidents.length > 0
  const bufferedAlert = streamState.bufferedCount > 0

  // ----- C: Copy Diagnostics -----
  // Builds a structured snapshot for paste-into-bug-report. Goal is to capture
  // enough state to answer "what was the UI seeing when this report was filed?"
  // without dumping multi-MB content blobs. Per-event content is truncated to
  // length (chars only). Larger raw content lives in MongoDB and can be fetched
  // separately via the event_id.
  const [copyStatus, setCopyStatus] = useState('idle')
  const buildDiagnosticSnapshot = () => {
    const arr = Array.isArray(allEvents) ? allEvents : []
    // SSE delivery-lag instrumentation. `e.data.timestamp` is the BE emit time;
    // `e.timestamp` is the FE arrival time (Date stamped at pushEvent in
    // useProjectEvents.js). `deliveryLagMs` is the wall-clock delay between
    // them. Large positive lag on a `task_attempt` event means the FE saw
    // the event minutes after the BE emitted it — which is the suspect
    // mechanism behind the "agentsPending empty at screenshot moment"
    // case on project 17ffbbfa: hypothesis H1 says task_attempt was
    // emitted at 11:42:59.285 but didn't reach the FE until well after
    // 11:43:26, leaving the status line to pin to critic_expert's
    // stale text.done with no agentsPending entry to suppress it.
    const last60 = arr.slice(-60).map(e => {
      const emittedAtStr = e?.data?.timestamp || null
      const receivedAt = e?.timestamp instanceof Date ? e.timestamp : null
      let deliveryLagMs = null
      if (emittedAtStr && receivedAt) {
        // Parse BE emit time. Handle the same naive-UTC case the FE handles
        // elsewhere (LiveActivity.eventEmittedAtMs) — phase events have
        // historically lacked a TZ designator, breaking Date.parse on
        // non-UTC viewers. Same regex.
        const naiveIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/
        const norm = typeof emittedAtStr === 'string' && naiveIso.test(emittedAtStr)
          ? `${emittedAtStr}Z`
          : emittedAtStr
        const emittedMs = typeof norm === 'number'
          ? (norm > 1e12 ? norm : norm * 1000)
          : Date.parse(norm)
        if (Number.isFinite(emittedMs)) {
          deliveryLagMs = receivedAt.getTime() - emittedMs
        }
      }
      return {
        id: e?.id || null,
        type: e?.type || null,
        timestamp: emittedAtStr || (receivedAt ? receivedAt.toISOString() : null),
        receivedAt: receivedAt ? receivedAt.toISOString() : null,
        deliveryLagMs,
        agent_id: e?.data?.agent_id || null,
        run_id: e?.data?.run_id || null,
        content_chars: typeof e?.data?.content === 'string' ? e.data.content.length : 0,
        thinking_time: e?.data?.thinking_time || null,
        finish_reason: e?.data?.finish_reason || null,
      }
    })
    return {
      capturedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      pageUrl: typeof window !== 'undefined' ? window.location.href : null,
      project: {
        id: project?.id || project?.project_id || null,
        title: project?.title || null,
        status: project?.status || null,
        current_phase: project?.current_phase || null,
        current_run_id: project?.current_run_id || project?.run_id || null,
        version: project?.version || null,
        approval_mode: project?.approval_mode || null,
        model_id: project?.model_id || null,
        workflow_id: project?.workflow_id || null,
      },
      pendingApproval: pendingApproval ? {
        approval_id: pendingApproval?.data?.approval_id || null,
        gate_type: pendingApproval?.data?.gate_type || pendingApproval?.subtype || null,
        gate_node_id: pendingApproval?.data?.gate_node_id || null,
        timestamp: pendingApproval?.data?.timestamp || pendingApproval?.timestamp || null,
      } : null,
      liveState: {
        currentPhase: live?.currentPhase || null,
        activeAgent: live?.activeAgent || null,
        phaseStartMs: live?.phaseStartMs || null,
        phaseElapsedMs,
        projectStatus: live?.projectStatus || null,
        projectDone: live?.projectDone || null,
        phases: live?.phases || [],
      },
      streamState: {
        bufferedCount: streamState?.bufferedCount || 0,
        activeCount: streamState?.activeCount || 0,
        concurrencyIncidents: streamState?.concurrencyIncidents || [],
        streams: (streamState?.streams || []).map(s => ({
          agent_id: s.agent_id,
          phase: s.phase,
          kind: s.kind,
          firstMs: s.firstMs,
          lastMs: s.lastMs,
          deltaCount: s.deltaCount,
          thinkingChars: s.thinkingChars,
          textChars: s.textChars,
          buffered: s.buffered,
          active: s.active,
          wireElapsedMs: s.wireElapsedMs,
          closureReason: s.closureReason,
        })),
      },
      recentEvents: last60,
      eventCounts: {
        total: arr.length,
        approval_requested: arr.filter(e => e?.type === 'approval_requested').length,
        approval_given: arr.filter(e => e?.type === 'approval_given').length,
        thinking_done: arr.filter(e => e?.type === 'agent.streaming.thinking.done').length,
        text_done: arr.filter(e => e?.type === 'agent.streaming.text.done').length,
        streaming_terminated: arr.filter(e => e?.type === 'agent.streaming.terminated').length,
        streaming_closed: arr.filter(e => e?.type === 'agent.streaming.closed').length,
      },
    }
  }
  const handleCopyDiagnostics = async () => {
    try {
      const snap = buildDiagnosticSnapshot()
      const json = JSON.stringify(snap, null, 2)
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(json)
        setCopyStatus('ok')
      } else {
        // Fallback for older browsers / non-secure contexts.
        const ta = document.createElement('textarea')
        ta.value = json
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopyStatus('ok')
      }
    } catch (e) {
      console.error('Copy diagnostics failed', e)
      setCopyStatus('err')
    }
    setTimeout(() => setCopyStatus('idle'), 1500)
  }

  return (
    <>
      {/* Edge handle — visible when drawer closed. Made deliberately prominent
          so it's discoverable even without the keyboard shortcut. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Open diagnostics (Ctrl+I)"
          className={`fixed right-0 top-1/2 -translate-y-1/2 z-30 h-32 w-7 flex flex-col items-center justify-center gap-1 bg-slate-800 hover:bg-slate-700 border border-r-0 border-slate-600 rounded-l-md text-slate-300 hover:text-slate-100 shadow-lg group transition-colors ${concurrencyAlert ? 'ring-2 ring-red-500/60 animate-pulse' : ''}`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span className="text-[9px] font-mono tracking-wider [writing-mode:vertical-rl] rotate-180">DIAG</span>
          {(concurrencyAlert || bufferedAlert) && (
            <span className={`absolute -left-1 -top-1 w-2 h-2 rounded-full ${concurrencyAlert ? 'bg-red-400' : 'bg-amber-400'}`}></span>
          )}
        </button>
      )}

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 bottom-0 z-40 flex flex-col bg-slate-950 border-l border-slate-700/40 transform transition-transform duration-150 ease-out ${open ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: `${DRAWER_WIDTH}px` }}
      >
        {/* Title bar */}
        <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between bg-slate-950/95">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-sans text-slate-200 font-medium">Diagnostics</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopyDiagnostics}
              className={`px-2 py-1 rounded text-[11px] font-mono inline-flex items-center gap-1 transition-colors ${
                copyStatus === 'ok'
                  ? 'bg-emerald-900/40 text-emerald-200 border border-emerald-700/40'
                  : copyStatus === 'err'
                    ? 'bg-red-900/40 text-red-200 border border-red-700/40'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-slate-100 border border-slate-700/40'
              }`}
              title="Copy structured diagnostics snapshot (project state + last 60 events + stream state) to clipboard"
            >
              <Copy className="w-3 h-3" />
              {copyStatus === 'ok' ? 'Copied' : copyStatus === 'err' ? 'Failed' : 'Copy diag'}
            </button>
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-200 ml-1" title="Close (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live header */}
        <div className="px-3 py-2 border-b border-slate-800 space-y-1.5 font-mono text-[12px]">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${liveDotCls}`}></span>
            <span className="text-slate-500 font-sans text-[11px] w-12 shrink-0">phase</span>
            <span className="text-slate-100 truncate">{live.currentPhase || '—'}</span>
            <span className="ml-auto text-slate-400">{formatElapsed(phaseElapsedMs)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 shrink-0"></span>
            <span className="text-slate-500 font-sans text-[11px] w-12 shrink-0">agent</span>
            <span className="text-slate-200 truncate" title={live.activeAgent || ''}>{formatAgentName(live.activeAgent)}</span>
            {agentContextUrl && (
              <a
                href={agentContextUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-slate-500 hover:text-slate-200 shrink-0"
                title="Open agent context JSON in a new tab"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {agentContextUrl && (
              <button
                type="button"
                onClick={() => setAgentRefreshTick(t => t + 1)}
                className="text-slate-500 hover:text-slate-200 shrink-0"
                title="Refresh agent context"
                disabled={agentContextLoading}
              >
                <RefreshCw className={`w-3 h-3 ${agentContextLoading ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 shrink-0"></span>
            <span className="text-slate-500 font-sans text-[11px] w-12 shrink-0">model</span>
            <span className="text-slate-200 truncate" title={live.model || ''}>{live.model || '—'}</span>
            {live.model && (
              <span
                className="text-[10px] px-1 py-0.5 rounded border text-slate-400 border-slate-700"
                title="Real model after fallback resolution will land in piece 3 of the brief. For now this is the configured value from project state."
              >
                configured
              </span>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="px-3 py-2 border-b border-slate-800">
          <PhaseTimeline
            phases={live.phases}
            currentPhase={live.currentPhase}
            projectDone={live.projectDone}
            projectStatus={live.projectStatus}
          />
        </div>

        {/* Inspector */}
        <div className="flex-1 overflow-y-auto">
          <Section
            icon={FileText}
            title="System prompt"
            accent={agentContextLoading ? 'loading' : (agentContextError ? 'error' : null)}
            accentClass={agentContextError ? 'text-red-400 border-red-700' : null}
          >
            <SystemPromptBody ctx={agentContext} error={agentContextError} loading={agentContextLoading} hasAgent={!!activeAgent} />
          </Section>

          <Section
            icon={MessageSquare}
            title="Conversation"
            count={agentContext?.conversation_preview?.length || null}
          >
            <ConversationBody ctx={agentContext} error={agentContextError} loading={agentContextLoading} hasAgent={!!activeAgent} />
          </Section>

          <Section
            icon={Wrench}
            title="Tools"
            count={agentContext?.tools?.length || null}
          >
            <ToolsBody ctx={agentContext} error={agentContextError} loading={agentContextLoading} hasAgent={!!activeAgent} />
          </Section>

          <Section
            icon={Zap}
            title="Streams"
            count={streamState.streams.length}
            accent={streamState.bufferedCount > 0 ? `${streamState.bufferedCount} buffered` : (streamState.activeCount > 0 ? `${streamState.activeCount} active` : null)}
            accentClass={streamState.bufferedCount > 0 ? 'text-amber-300/80 border-amber-500/30' : 'text-blue-300/80 border-blue-500/30'}
            defaultOpen={streamState.bufferedCount > 0 || streamState.activeCount > 0}
          >
            {streamState.streams.length === 0 ? (
              <div className="text-[11px] text-slate-500 italic font-sans">No streams recorded yet</div>
            ) : (
              <div className="space-y-1.5">
                {streamState.streams.slice(0, 30).map(s => (
                  <div key={s.key} className="flex items-center gap-2 text-[11px] font-mono">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.active ? 'bg-blue-400 animate-pulse' : (s.closureReason === 'closed' ? 'bg-slate-600' : (s.closureReason ? 'bg-red-400' : 'bg-slate-500'))}`}></span>
                    <span className="text-slate-200 truncate min-w-0 max-w-[120px]" title={s.agent_id}>{formatAgentName(s.agent_id)}</span>
                    {s.kind && (
                      <span className="text-slate-500 shrink-0" title={s.kind}>{s.kind === 'thinking' ? 'thnk' : (s.kind === 'text' ? 'text' : '…')}</span>
                    )}
                    <span className="text-slate-500 truncate">{s.phase || '—'}</span>
                    <span className="ml-auto text-slate-400 shrink-0">{formatElapsed(s.wireElapsedMs)}</span>
                    {s.buffered && (
                      <span className="text-[10px] px-1 rounded border text-amber-300/80 border-amber-500/30 shrink-0" title={`${s.deltaCount} delta · ${s.thinkingChars + s.textChars} chars in one chunk`}>buf</span>
                    )}
                    {s.closureReason && s.closureReason !== 'closed' && (
                      <span className="text-[10px] px-1 rounded border text-red-300/80 border-red-500/40 shrink-0">{s.closureReason}</span>
                    )}
                    <span className="text-slate-600 shrink-0" title={`${s.deltaCount} deltas · ${s.thinkingChars + s.textChars} chars`}>×{s.deltaCount}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            icon={AlertTriangle}
            title="Concurrency"
            accent={concurrencyAlert ? `${streamState.concurrencyIncidents.length} incident${streamState.concurrencyIncidents.length === 1 ? '' : 's'}` : 'no warnings'}
            accentClass={concurrencyAlert ? 'text-red-300/80 border-red-500/40' : 'text-slate-500 border-slate-700'}
            defaultOpen={concurrencyAlert}
          >
            {!concurrencyAlert ? (
              <div className="text-[11px] text-slate-500 italic font-sans">No overlap detected</div>
            ) : (
              <div className="space-y-1.5">
                {streamState.concurrencyIncidents.slice(-10).reverse().map((inc, i) => (
                  <div key={i} className="text-[11px] font-mono text-slate-300">
                    <span className="text-red-400">⚠</span>{' '}
                    <span className="text-slate-200">{formatAgentName(inc.newAgent)}</span>
                    <span className="text-slate-500"> opened while {inc.existingCount} other(s) active</span>
                  </div>
                ))}
                <button
                  onClick={() => {
                    try { navigator.clipboard.writeText(JSON.stringify(streamState.concurrencyIncidents, null, 2)) } catch {}
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 font-sans"
                >
                  <Copy className="w-3 h-3" /> Copy as JSON
                </button>
              </div>
            )}
          </Section>

          <Section
            icon={Clock}
            title="Events"
            count={recent30.length}
            defaultOpen={false}
          >
            {recent30.length === 0 ? (
              <div className="text-[11px] text-slate-500 italic font-sans">No events</div>
            ) : (
              <div className="space-y-0.5 text-[11px] font-mono max-h-[280px] overflow-y-auto">
                {recent30.map((e, i) => {
                  const ms = eventEpochMs(e)
                  const time = ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
                  return (
                    <div key={i} className="flex gap-2 leading-tight">
                      <span className="text-slate-600 shrink-0">{time}</span>
                      <span className="text-slate-300 truncate" title={e?.type}>{e?.type || '—'}</span>
                      {e?.data?.agent_id && (
                        <span className="text-slate-500 truncate ml-auto max-w-[140px]" title={e.data.agent_id}>{formatAgentName(e.data.agent_id)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Section>

          <Section
            icon={ShieldCheck}
            title="Approvals"
            count={pendingApproval ? 1 : 0}
            accent={pendingApproval ? 'pending' : null}
            accentClass={pendingApproval ? 'text-amber-300/80 border-amber-500/30' : 'text-slate-500 border-slate-700'}
            defaultOpen={!!pendingApproval}
          >
            {!pendingApproval ? (
              <div className="text-[11px] text-slate-500 italic font-sans">No pending approval</div>
            ) : (
              <div className="text-[11px] font-mono">
                <div className="text-slate-300">
                  <span className="text-amber-300">⏸</span>{' '}
                  <span className="text-slate-200">{pendingApproval?.data?.gate_type || pendingApproval?.data?.type || 'approval'}</span>
                </div>
                {pendingApproval?.data?.approval_id && (
                  <div className="text-slate-500 mt-0.5 truncate">id {pendingApproval.data.approval_id}</div>
                )}
              </div>
            )}
          </Section>
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500 font-sans">
          <span className="text-slate-400">Ctrl+I</span> toggle · <span className="text-slate-400">esc</span> close
        </div>
      </div>
    </>
  )
}
