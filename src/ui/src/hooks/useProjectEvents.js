import { useState, useEffect, useRef, useMemo } from 'react'
import { apiFetch, apiUrl } from '../utils_api'
import { notify, notifyClear } from '../utils_notify'
import { createFetchEventSource } from '../utils/fetchEventSource'
import {
  isStreamingDeltaEvent,
  mergeEventsChronological,
} from '../utils/eventLogFilter'
import { liveRevertInFlight, revertSideEffects, takeRevertDraft } from '../utils/revertEffects'
import { runningMapProgress } from '../utils/mapProgress'

const STREAM_EVENTS_CAP = 3000
const REPLAY_COMPLETE_EVENT = 'replay_complete'

/**
 * Custom hook for SSE event handling and project state management.
 */
export default function useProjectEvents({
  projectId,
  project,
  setProject,
  sinceOverride,
  sseNonce,
}) {
  const [events, setEvents] = useState([])
  const [pendingApproval, setPendingApproval] = useState(null)
  const [pendingApprovals, setPendingApprovals] = useState([])
  // Legacy ephemeral delegation review gates. New agent-result gates are
  // persistent messages and bypass this transient collection.
  const [pendingDelegationApprovals, setPendingDelegationApprovals] = useState([])
  const [authError, setAuthError] = useState(null)
  const [stopped, setStopped] = useState(false)
  const [stoppedReason, setStoppedReason] = useState(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isReverting, setIsReverting] = useState(false)
  const [chatPrefill, setChatPrefill] = useState('')
  const [messageResetNonce, setMessageResetNonce] = useState(0)

  const autoCancelledRef = useRef(false)
  const finalizedRef = useRef(false)
  const lastExecEventAtRef = useRef(0)
  const notifiedAuthRef = useRef(false)
  const notifiedFinalRef = useRef(false)
  const notifiedSseErrorRef = useRef(false)
  // True between a live project_reverting and its outcome (the SSE route never
  // replays project_reverting). It keeps a revert live when a dropped
  // connection delivers the outcome in its catch-up replay.
  const isRevertingRef = useRef(false)
  // Watermark: the largest event_id we've ingested into `events`. Backend mints
  // UUID v7 (time-ordered, lex-sortable as a string) and sends it on the SSE
  // `id:` line, so anything <= this value is already in our array. Replaces
  // the prior type+timestamp Set, which was load-bearing in two ways and
  // unsound in both: timestamps collided across the dual-mint emit/save_event
  // bug, and Set growth was unbounded.
  const lastSeenEventIdRef = useRef('')
  // AppFactory-154: approval_ids of delegation gates already resolved/cancelled or
  // cleared by a terminal/revert event. The ephemeral approval_requested is
  // persisted and replays on reconnect; without this set a gate the backend already
  // dropped would resurrect as a dead "ghost" card. Once cleared, an id never
  // legitimately re-pends (each request_approval mints a fresh uuid), so it is safe.
  const clearedDelegationGatesRef = useRef(new Set())
  // Ephemeral SSE chunks (thinking/text/tool deltas) for Live Activity only.
  const streamEventsRef = useRef([])
  const [streamVersion, setStreamVersion] = useState(0)

  const allEventsForStreaming = useMemo(
    () => mergeEventsChronological(events, streamEventsRef.current),
    [events, streamVersion],
  )
  const mapProgress = useMemo(() => runningMapProgress(events), [events])

  // Restored through chatPrefill, not the composer: the project summary's
  // last_revert_prefill (an older revert's) fills only an empty chatPrefill.
  useEffect(() => {
    const draft = takeRevertDraft(projectId)
    if (draft) setChatPrefill(draft)
  }, [projectId])

  // Pre-seed Output approval preview on refresh
  useEffect(() => {
    if (!project) return
    if (pendingApproval) return
    try {
      const approvedKey = `output_approved_${projectId}`
      if (localStorage.getItem(approvedKey) === 'true') return
    } catch {}
    const art = project?.artifacts
    if (Array.isArray(art) && art.length > 0) {
      setPendingApproval({
        type: 'approval_requested',
        data: {
          approval_id: `${projectId}_output`,
          type: 'output',
          data: { artifacts: art }
        }
      })
    }
  }, [project?.artifacts, projectId, pendingApproval])

  // Pre-seed requirements/plan approval cards from project summary
  useEffect(() => {
    if (!project) return
    if (pendingApproval) return
    try {
      const fromSummary = project?.pending_approvals
      if (Array.isArray(fromSummary) && fromSummary.length > 0) {
        const first = fromSummary[0] || {}
        const approvalId = first.approval_id
        const gateType = first.gate_type || first.type
        const data = first.data
        if (approvalId && gateType) {
          setPendingApproval({
            type: 'approval_requested',
            data: { approval_id: approvalId, run_id: first.run_id, type: gateType, data },
          })
          return
        }
      }
    } catch {}
    const phase = (project.current_phase || '').toLowerCase()

    if (phase === 'requirements' || phase === 'initialization') {
      const reqs = project.requirements
      if (reqs && Object.keys(reqs).length > 0) {
        setPendingApproval({
          type: 'approval_requested',
          data: {
            approval_id: `${projectId}_requirements`,
            type: 'requirements',
            data: {
              requirements: reqs,
              answered_by_ai: (reqs.answered_questions || []),
              needs_human_input: (reqs.needs_human_input || []),
              inferred_decisions: (reqs.inferred_decisions || {}),
            },
          },
        })
        return
      }
    }

    if (phase === 'planning') {
      const plan = project.plan
      if (plan && Object.keys(plan).length > 0) {
        setPendingApproval({
          type: 'approval_requested',
          data: { approval_id: `${projectId}_plan`, type: 'plan', data: plan },
        })
      }
    }
  }, [project?.requirements, project?.plan, project?.current_phase, projectId, pendingApproval])

  // Reset the watermark when the user switches runs (RunsPanel click,
  // revert-as-fork). The SSE effect below also re-fires on a run change via
  // its URL query, but the watermark reset must precede the reconnect so
  // the replay isn't rejected as "old." The log empties with it: that replay
  // re-delivers the whole run, so a kept log would show it twice.
  useEffect(() => {
    lastSeenEventIdRef.current = ''
    setEvents([])
  }, [project?.current_run_id, project?.run_id])

  // Reflect stopped state from project summary
  useEffect(() => {
    if (!project) return
    if (project.status === 'cancelled' || project.status === 'failed' || project.status === 'completed') {
      setStopped(true)
      // AppFactory-154: a terminal run cannot have an open delegation gate; clear any
      // lingering review card and remember its id (the backend may have dropped the
      // gate silently, emitting no approval_given).
      setPendingDelegationApprovals(prev => {
        prev.forEach(a => { const id = a?.data?.approval_id; if (id) clearedDelegationGatesRef.current.add(id) })
        return prev.length ? [] : prev
      })
      if (!stoppedReason) setStoppedReason(
        project.status === 'cancelled' ? 'Project cancelled.'
          : project.status === 'completed' ? 'Project completed'
          : 'Project failed.'
      )
      setIsExecuting(false)
      finalizedRef.current = true
      if (!notifiedFinalRef.current) {
        notify({
          title: project.status === 'cancelled' ? 'Project cancelled' : project.status === 'completed' ? 'Project completed' : 'Project failed',
          message: project.status === 'failed' ? 'Open Events to view error details.' : undefined,
          variant: project.status === 'failed' ? 'error' : project.status === 'completed' ? 'success' : 'warning',
          ttl: 6000
        })
        notifiedFinalRef.current = true
      }
    }
  }, [project?.status])

  // SSE connection
  useEffect(() => {
    if (projectId.startsWith('creating-')) return

    streamEventsRef.current = []
    setStreamVersion(0)

    const baseSince = sinceOverride || project?.created_at
    const currentRunId = project?.current_run_id || project?.run_id
    const params = new URLSearchParams()
    if (baseSince) params.set('since', baseSince)
    if (currentRunId) params.set('run_id', currentRunId)
    const queryStr = params.toString() ? `?${params.toString()}` : ''
    const sseUrl = apiUrl(`/projects/${projectId}/events${queryStr}`)
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : null
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}
    let sseConnection = null
    // Frames before the server's replay_complete marker are history, not live.
    // Every reconnect replays again, so onOpen re-arms this.
    let replaying = true

    // Watermark dedup — UUID v7 is lex-sortable as a string, so `>` ordering
    // matches chronological order. Any event with id <= the watermark is
    // already in `events` (either via replay or a prior live delivery).
    // The route subscribes before reading history, so an event saved in
    // between arrives twice; skip it before any side effect, not just the log.
    const isNewEvent = (lastEventId) => {
      const id = lastEventId || ''
      if (!id) {
        // No event_id on the wire — pre-migration event or a synthetic. Let
        // it through but don't advance the watermark; risk of duplication is
        // bounded because backfill_event_id eliminates legacy gaps.
        return true
      }
      if (id <= lastSeenEventIdRef.current) return false
      lastSeenEventIdRef.current = id
      return true
    }

    const pushEvent = (type, payload, lastEventId) => {
      const id = lastEventId || ''

      // Run-scoped filter — backend now stamps `run_id` on every emit (or
      // `null` for project-lifecycle events). Lenient: events without run_id
      // are admitted to every view; events with a non-null run_id only show
      // in their own run's view.
      const eventRunId = payload?.run_id
      if (eventRunId != null && currentRunId && eventRunId !== currentRunId) return

      const entry = {
        type,
        data: payload,
        timestamp: new Date(),
        id: id || payload?.timestamp,
      }

      // Streaming deltas: live UI only, not Event Log / badge / export.
      if (isStreamingDeltaEvent(type)) {
        const buf = streamEventsRef.current
        streamEventsRef.current =
          buf.length >= STREAM_EVENTS_CAP
            ? [...buf.slice(-(STREAM_EVENTS_CAP - 1)), entry]
            : [...buf, entry]
        setStreamVersion((v) => v + 1)
        return
      }

      // Memory bound on logical events: cap at 5000, trim the oldest.
      setEvents((prev) => {
        return prev.length >= 5000 ? [...prev.slice(-4999), entry] : [...prev, entry]
      })
    }

    const looksLikeInvalidKey = (msg) => {
      if (!msg) return false
      const s = String(msg).toLowerCase()
      return (
        s.includes('invalid_api_key') || s.includes('invalid api key') ||
        s.includes('invalid openai api key') || s.includes('incorrect api key provided') ||
        s.includes('error code: 401') || s.includes('401 unauthorized') || s.includes('unauthorized')
      )
    }

    const tryAutoCancel = async (reason) => {
      if (autoCancelledRef.current) return
      autoCancelledRef.current = true
      setAuthError(reason || 'Invalid OpenAI API key')
      setIsExecuting(false)
      finalizedRef.current = true
      if (!notifiedAuthRef.current) {
        notify({
          title: 'Invalid OpenAI API key',
          message: 'Open Settings to update your key, then create a new project.',
          variant: 'error',
          action: { label: 'Open Settings', href: '/settings' },
          ttl: 8000
        })
        notifiedAuthRef.current = true
      }
      try {
        await apiFetch(`/projects/${projectId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason || 'Invalid OpenAI API key - auto-cancelled' })
        })
        apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data))
      } catch (e) {
        console.error('Auto-cancel failed:', e)
      }
    }

    const handler = (type) => (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (!isNewEvent(event.lastEventId)) return
        pushEvent(type, payload, event.lastEventId)

        if (type === 'project_started' || (typeof type === 'string' && type.endsWith('.started'))) {
          finalizedRef.current = false
          setStopped(false)
          setStoppedReason(null)
          notifiedFinalRef.current = false
          apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data)).catch(() => {})
        }

        if (type === 'project_failed') {
          setStopped(true)
          setStoppedReason(payload?.error || 'Project failed')
          setIsExecuting(false)
          finalizedRef.current = true
          try { if (sseConnection) sseConnection.close() } catch {}
          if (!notifiedFinalRef.current) {
            notify({ title: 'Project failed', message: (payload?.error || '').toString().slice(0, 500), variant: 'error', ttl: 8000 })
            notifiedFinalRef.current = true
          }
          apiFetch(`/projects/${projectId}`).then(res => res.json()).then(data => setProject(data))
        }

        if (type === 'project_completed') {
          // Refresh the project doc so `project.status` flips from "running"
          // to "completed" locally. Without this, LiveActivity.visible()
          // (which checks terminalStatuses against project.status) never
          // hides the bottom strip after the workflow ends, leaving stale
          // tool_executed/task_attempt events stopwatching indefinitely —
          // verified on project ad25ded2 where Mongo had status="completed"
          // at 11:46:25.766 but the FE diag at 12:01:56 still showed
          // status="running" and the strip read "Tool read completed
          // [15m 51s]". `project_started` and `project_failed` already
          // refetch (lines above); completion was the missing symmetric
          // branch. Marking finalizedRef mirrors the failure path so any
          // late event doesn't flip isExecuting back to true.
          finalizedRef.current = true
          apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data)).catch(() => {})
        }

        if (type === 'project_stopped') {
          // Revert cancels with reason="Reverting"; project_reverted resets UI shortly after.
          if (payload?.reason !== 'Reverting') {
            finalizedRef.current = true
            setIsExecuting(false)
            setStopped(true)
            setStoppedReason((prev) => prev || 'Project cancelled.')
            apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data)).catch(() => {})
          }
        }

        if (finalizedRef.current) {
          setIsExecuting(false)
        } else {
          if (type === 'project_started') { setIsExecuting(true); setStopped(false); setStoppedReason(null); setAuthError(null); notifyClear(); lastExecEventAtRef.current = Date.now() }
          if (type === 'project_completed') { setIsExecuting(false) }
          if (type === 'project_failed') { setIsExecuting(false); try { if (sseConnection) sseConnection.close() } catch {} }
          if (type === 'approval_requested') setIsExecuting(false)
          if (type.endsWith('.started')) { setIsExecuting(true); setStopped(false); setStoppedReason(null); setAuthError(null); notifyClear(); lastExecEventAtRef.current = Date.now() }
          if (type.endsWith('.completed')) setIsExecuting(false)
          if (type.startsWith('auction') || type === 'task_attempt' || type === 'task_completed' || type === 'tool_executed') {
            setIsExecuting(true)
            setStopped(false)
            setStoppedReason(null)
            lastExecEventAtRef.current = Date.now()
          }
        }

        try {
          if (type && type.startsWith('phase.')) {
            setProject(prev => {
              if (!prev) return prev
              // Generic phase name extraction — workflow_engine emits
              // `phase.<phase_label>.<status>`, where phase_label is
              // workflow-defined (requirements/planning/execution/deployment/...).
              // The previous if/else chain enumerated requirements/planning/
              // execution/output by name and dropped everything else (e.g.
              // `phase.deployment.started` → ignored). Now we take the
              // middle segment of the event type verbatim.
              const parts = type.split('.')
              const fromType = parts.length >= 3 ? parts.slice(1, -1).join('.') : ''
              const nextPhase = fromType || prev.current_phase || ''
              const patch = { ...prev, current_phase: nextPhase }
              if (type.endsWith('.started')) patch.status = 'running'
              return patch
            })
          }
        } catch {}

        if (looksLikeInvalidKey(payload?.error || payload?.message || payload)) {
          tryAutoCancel('Invalid OpenAI API key detected')
        }

        const revertStartedLive = isRevertingRef.current
        isRevertingRef.current = liveRevertInFlight(revertStartedLive, type)

        if (type === 'project_reverting') {
          setIsReverting(true)
          notify({ title: 'Reverting...', message: 'Restoring previous state', variant: 'info', ttl: 2500 })
        }

        if (type === 'project_reverted') {
          const fx = revertSideEffects(!replaying || revertStartedLive)
          setIsExecuting(false)
          setPendingApproval(null)
          // A reverted delegation gate's parked executor no longer exists, so
          // clear its card and remember the id — a later replay of its
          // approval_requested must not resurrect it as a dead ghost card.
          setPendingDelegationApprovals(prev => {
            prev.forEach(a => { const id = a?.data?.approval_id; if (id) clearedDelegationGatesRef.current.add(id) })
            return prev.length ? [] : prev
          })
          apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => {
            setProject(data)
            // Restore pending approval from fetched project data
            try {
              const fromSummary = data?.pending_approvals
              if (Array.isArray(fromSummary) && fromSummary.length > 0) {
                const first = fromSummary[0] || {}
                const approvalId = first.approval_id
                const gateType = first.gate_type || first.type
                const approvalData = first.data
                if (approvalId && gateType) {
                  setPendingApproval({
                    type: 'approval_requested',
                    data: { approval_id: approvalId, run_id: first.run_id, type: gateType, data: approvalData },
                  })
                }
              }
            } catch {}
            try {
              const md = data?.metadata
              const candidate = (md && typeof md === 'object') ? md.last_revert_prefill : null
              if (typeof candidate === 'string' && candidate.trim()) {
                setChatPrefill(prev => prev && prev.trim() ? prev : candidate.trim())
              }
            } catch {}
          }).catch(() => {})
          setIsReverting(false)
          // The Events log survives a revert; keep its watermark so replay/live
          // duplicates cannot reapply effects.
          if (fx.resetCurrentActivity) {
            streamEventsRef.current = []
            setStreamVersion((v) => v + 1)
          }
          if (fx.announceReverted) {
            notify({ title: 'Project reverted', message: 'State restored from snapshot.', variant: 'success', ttl: 3000 })
          }
          if (fx.resetComposer) {
            setMessageResetNonce(prev => prev + 1)
          }
          if (fx.applyPrefill) {
            try {
              const nextPrefill = (payload && typeof payload.prefill_input === 'string') ? payload.prefill_input.trim() : ''
              setChatPrefill(nextPrefill)
            } catch {}
          }
        }

        if (type === 'project_revert_failed') {
          setIsReverting(false)
          notify({ title: 'Revert failed', message: (payload?.error || 'Snapshot not found'), variant: 'error', ttl: 6000 })
        }

        if (type === 'approval_requested') {
          const normalized = {
            ...(payload || {}),
            approval_id: payload?.approval_id,
            type: payload?.gate_type || payload?.type,
            data: payload?.data,
          }
          if (
            payload?.data?.delegation_gate === true &&
            payload?.data?.persisted !== true
          ) {
            // Ephemeral delegation review gate — render a transient card straight
            // from this event, separate from the normal message-backed approval flow.
            const aid = normalized?.approval_id
            // Don't resurrect a gate the backend already resolved/cancelled/cleared
            // (this event replays from storage on every reconnect).
            if (aid && clearedDelegationGatesRef.current.has(aid)) return
            setPendingDelegationApprovals(prev =>
              prev.some(a => a.data?.approval_id === normalized?.approval_id)
                ? prev
                : [...prev, { type, data: normalized }]
            )
            return
          }
          setPendingApprovals(prev => {
            if (prev.some(a => a.data?.approval_id === normalized?.approval_id)) return prev
            return [...prev, { type, data: normalized }]
          })
          setPendingApproval(prev => {
            if (!prev) return { type, data: normalized }
            try {
              const prevId = prev?.data?.approval_id || ''
              const nextId = normalized?.approval_id || ''
              const prevType = (prev?.data?.type || '').toLowerCase()
              const nextType = (normalized?.type || '').toLowerCase()
              // Always replace if approval_id is different (new approval supersedes old)
              if (nextId && prevId !== nextId) return { type, data: normalized }
              if (prevType && nextType && prevType !== nextType) return { type, data: normalized }
              if (prevId.includes('_') && nextId && !nextId.includes('_')) return { type, data: normalized }
            } catch {}
            return prev
          })
          // Also update project.pending_approvals so handleApproval can find the approval_id
          setProject(prev => {
            if (!prev) return prev
            const existing = prev.pending_approvals || []
            if (existing.some(a => a.approval_id === normalized.approval_id)) return prev
            return { ...prev, pending_approvals: [...existing, normalized] }
          })
        } else if (type === 'approval_updated') {
          const normalized = { ...(payload || {}), approval_id: payload?.approval_id, type: payload?.type, data: payload?.data }
          setPendingApprovals(prev => prev.map(a => a.data?.approval_id === normalized?.approval_id ? { type, data: normalized } : a))
          setPendingApproval(prev => {
            if (!prev) return { type, data: normalized }
            if (prev.data.approval_id !== normalized.approval_id) return prev
            return { type, data: normalized }
          })
          apiFetch(`/projects/${projectId}`).then(res => res.json()).then(data => setProject(data)).catch(() => {})
        } else if (type === 'approval_given') {
          if (payload?.approval_id) clearedDelegationGatesRef.current.add(payload.approval_id)
          setPendingDelegationApprovals(prev => prev.filter(a => a.data?.approval_id !== payload?.approval_id))
          setPendingApprovals(prev => prev.filter(a => a.data?.approval_id !== payload?.approval_id))
          setPendingApproval(prev => {
            try {
              const aid = payload?.approval_id || ''
              const status = (payload?.status || '').toLowerCase()
              if (aid.endsWith('_output') && status === 'approved') {
                localStorage.setItem(`output_approved_${projectId}`, 'true')
              }
              if (!prev) return prev
              const currentId = prev?.data?.approval_id || ''
              if (currentId && currentId !== aid) return prev
            } catch {}
            return null
          })
          apiFetch(`/projects/${projectId}`).then(res => res.json()).then(data => setProject(data))
        }

        if (type && type.startsWith('deploy_')) {
          apiFetch(`/projects/${projectId}`).then(res => res.json()).then(data => setProject(data)).catch(() => {})
        }
      } catch (e) {
        console.error('SSE parse error:', e)
      }
    }

    const eventTypes = [
      'project_started', 'project_completed', 'project_failed', 'project_stopping', 'project_stopped',
      'project_reverting', 'project_reverted', 'project_revert_failed', 'task_error', 'task_failed',
      'approval_requested', 'approval_updated', 'approval_given', 'container_created', 'container_checkout',
      'container_tested', 'container_applied', 'snapshot_created',
      'phase.requirements.started', 'phase.requirements.completed', 'phase.planning.started',
      'phase.planning.completed', 'phase.execution.started', 'phase.execution.completed',
      'phase.output.started', 'phase.output.completed',
      'phase.deployment.started', 'phase.deployment.completed',
      // Phase event names listed here pre-warm the handler cache for the
      // default workflow's phases. Unknown phase labels (custom workflows
      // declaring phase_label="research", "qa", etc. — see
      // orchestration/workflow_engine.py:92-98 which emits `phase.<label>.
      // <status>` dynamically) are no longer collapsed onto handler('message');
      // they get a real handler closure with the actual type via the
      // miss-create-and-cache path in onEvent below, so the generic
      // `type.startsWith('phase.')` updater at ~line 293 sees the right type.
      'auction_started', 'auction_bid_started', 'auction_bid_completed', 'auction_bid_timeout',
      'auction_bid_failed', 'auction_best_bid', 'auction_rejected', 'auction_completed',
      'task_attempt', 'task_completed', 'tool_executed',
      'map.started', 'map.item_started', 'map.item_finished', 'map.completed',
      'deploy_started', 'deploy_succeeded', 'deploy_failed',
      // Intent classifier runs synchronously inside the messages route and
      // can take 20-30s on slow LLMs. These two events bracket the call so
      // LiveActivity can show "Processing your message…" instead of leaving
      // the stale "Awaiting approval" gate visible with its old stopwatch.
      'intent_routing_started', 'intent_routing_completed',
      // Streaming events for real-time thinking/tool display
      'agent.streaming.thinking.delta', 'agent.streaming.thinking.done',
      'agent.streaming.tool_call.start', 'agent.streaming.tool_call.executing', 'agent.streaming.tool_call.result',
      'agent.streaming.tool_call.error',
      'agent.streaming.text.delta', 'agent.streaming.text.done',
      'agent.streaming.error',
      'agent.streaming.round.retry',
      // AppFactory-154 delegation timeline events.
      'agent.delegation.started', 'agent.delegation.completed', 'agent.delegation.failed',
      // Termination signals — UI badges the matching thought when these fire.
      // agent.validation.timeout: auction.wait_for(critic.execute_task) timed out.
      // agent.streaming.terminated: streaming closure exited via exception.
      // agent.streaming.closed: streaming closure exited naturally; UI uses
      //   its `elapsed` field to detect provider-buffered responses.
      'agent.validation.timeout', 'agent.streaming.terminated',
      'agent.streaming.closed',
      // Debug: backend-side overlap detection (see _stream_open in agents/base.py).
      // ConcurrencyDebugPanel surfaces these alongside its own UI-derived signal.
      'agent.streaming.concurrency_warning',
    ]

    const handlersByType = {}
    eventTypes.forEach((t) => { handlersByType[t] = handler(t) })

    sseConnection = createFetchEventSource(sseUrl, {
      headers: authHeaders,
      onEvent: (type, data, id) => {
        if (type === REPLAY_COMPLETE_EVENT) {
          replaying = false
          return
        }
        const syntheticEvent = { data, lastEventId: id }
        // Cache miss creates a handler bound to the *real* type so the
        // closure-captured `type` inside handler() is correct for the
        // dynamic dispatch branches (phase.* updater, .started/.completed
        // suffix checks, auction-prefix exec flag). Previously this fell
        // back to a single handler('message') closure, silently rewriting
        // every unenumerated type to 'message' before dispatch.
        let fn = handlersByType[type]
        if (!fn) {
          fn = handler(type)
          handlersByType[type] = fn
        }
        fn(syntheticEvent)
      },
      onError: (err) => {
        console.warn('SSE error:', err)
        if (!notifiedSseErrorRef.current && !finalizedRef.current) {
          notify({ title: 'Connection lost', message: 'Disconnected from backend. Reconnecting...', variant: 'warning', ttl: 5000 })
          notifiedSseErrorRef.current = true
        }
      },
      onOpen: () => {
        replaying = true
        notifiedSseErrorRef.current = false
      },
    })

    return () => {
      if (sseConnection) sseConnection.close()
    }
    // `project?.current_run_id` and `project?.run_id` are part of the SSE
    // URL via `currentRunId` (line 152). Without them in the dep array, the
    // SSE wouldn't reconnect when the active run changes (RunsPanel
    // activate flow); we'd stay subscribed to events scoped to the previous
    // run and the UI would silently miss the new run's stream.
  }, [projectId, project?.created_at, sseNonce, sinceOverride, project?.current_run_id, project?.run_id])

  // Derive execution state from project status and approval state
  useEffect(() => {
    if (finalizedRef.current) return
    const status = (project?.status || '').toLowerCase()
    const nonExecStatuses = new Set(['', 'initialized', 'cancelled', 'failed', 'completed'])
    if (pendingApproval || nonExecStatuses.has(status)) {
      setIsExecuting(false)
    }
  }, [project?.status, pendingApproval])

  // Inactivity watchdog
  useEffect(() => {
    if (finalizedRef.current) return
    const id = setInterval(() => {
      if (!finalizedRef.current && isExecuting) {
        const last = lastExecEventAtRef.current || 0
        if (last && Date.now() - last > 8000) setIsExecuting(false)
      }
    }, 3000)
    return () => clearInterval(id)
  }, [isExecuting])

  return {
    events,
    allEventsForStreaming,
    mapProgress,
    setEvents,
    pendingApproval,
    setPendingApproval,
    pendingApprovals,
    setPendingApprovals,
    pendingDelegationApprovals,
    setPendingDelegationApprovals,
    authError,
    setAuthError,
    stopped,
    setStopped,
    stoppedReason,
    setStoppedReason,
    isExecuting,
    setIsExecuting,
    isReverting,
    setIsReverting,
    chatPrefill,
    setChatPrefill,
    messageResetNonce,
    finalizedRef,
    lastExecEventAtRef,
    lastSeenEventIdRef,
    notifiedFinalRef,
  }
}
