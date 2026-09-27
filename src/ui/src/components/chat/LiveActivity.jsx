import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronDown, ChevronRight, Clock, Loader, Brain } from 'lucide-react'
import { summarizeEvent, iconForEvent, labelClassForEvent, isApprovalWait, isInProgress } from './eventHelpers'

function formatAgentName(agentId) {
  if (!agentId) return null
  const base = agentId.split('@')[0].replace(/_\d+$/, '')
  return base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Compact stopwatch label: 1s, 47s, 1m 12s, 12m 4s. Used everywhere we
// show elapsed time so the format is consistent.
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${s}s`
}

// useProjectEvents.js:166 stamps `e.timestamp = new Date()` at the moment
// the event lands in the UI — which on a page refresh is the refresh time,
// not when the backend actually emitted the event. The original backend
// timestamp lives on the payload (`e.data.timestamp`), so prefer that.
// Fallback chain handles legacy events that lack the payload field.
// Match `YYYY-MM-DDTHH:MM:SS[.fraction]` with NO trailing timezone designator
// (Z, +HH:MM, or -HH:MM). The BE has historically emitted naive UTC strings
// via `datetime.utcnow().isoformat()` for several event payloads — most
// notoriously phase events from phase_runner.py:337. Per ECMAScript spec
// (es5+), `Date.parse` of such a date-time string is interpreted as LOCAL
// time, producing a stopwatch offset equal to the user's UTC offset.
// Verified on project 7c2243a7 (UTC+1 user) where phase events stopwatched
// at "60m 5s" instead of "5s". phase_runner.py is now fixed to emit
// timezone-aware UTC, but other call sites still use the naive form and
// any future regression would be silent — this guard catches all of them.
const NAIVE_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/

function eventEmittedAtMs(e) {
  const dt = e?.data?.timestamp
  if (typeof dt === 'string') {
    const isoString = NAIVE_ISO_DATETIME.test(dt) ? `${dt}Z` : dt
    const parsed = Date.parse(isoString)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof dt === 'number') return dt > 1e12 ? dt : dt * 1000
  if (e?.timestamp instanceof Date) return e.timestamp.getTime()
  return Date.now()
}

export default function LiveActivity({
  project,
  recentEvents,
  pendingApproval,
  isExecuting,
  isReverting,
  isLoading,
  isPrefillResume
}) {
  // ALL per-agent display state is DERIVED from events, not stored.
  //
  // History: this component used to keep three useState dicts (agentsThinking,
  // agentsWriting, agentsPending) and incrementally mutate them inside a
  // useEffect with an event-id watermark. That design had two failure modes
  // the user demonstrated and called architectural:
  //
  //   1. Tab switch (Chat → Events → Chat) unmounts/remounts LiveActivity.
  //      The watermark ref and state dicts reset to empty, then the effect
  //      filters out events with id <= watermark (still ''), so on first
  //      remount it DID re-process all recentEvents — but only if the
  //      events array reference changed. If recentEvents was stable, the
  //      state remained empty until the next event arrived. Result: the
  //      "X is processing..." badge disappeared and the stopwatch reset.
  //
  //   2. agentsPending only fired for the auction winner. Every sequential
  //      workflow agent after that (human_expert, finalizer, output, etc.)
  //      got NO pending indicator — verified on project fec87717-... where
  //      the user saw 31s+ of silence between agents with zero feedback.
  //
  // The fix for BOTH is the same: state = f(events). The useMemo below walks
  // recentEvents from scratch on every render and produces the current
  // thinking/writing/pending dicts. State survives remounts identically and
  // any signal we want to surface comes from events that the backend emits
  // — no more component-local accumulation. Stopwatches use event timestamps
  // (eventEmittedAtMs), so they don't reset when the component remounts.
  //
  // The "X is processing..." pending state is now keyed off `task_attempt`
  // events. The backend's phase_runner/task_executor emit task_attempt
  // before every agent.execute_task call — uniform across auction-selected
  // and sequentially-invoked agents.
  const { agentsThinking, agentsWriting, agentsPending } = useMemo(() => {
    const thinking = {}
    const writing = {}
    const pending = {}
    if (!Array.isArray(recentEvents) || recentEvents.length === 0) {
      return { agentsThinking: thinking, agentsWriting: writing, agentsPending: pending }
    }

    for (const e of recentEvents) {
      const type = e?.type || ''
      if (!type) continue
      const aid = e?.data?.agent_id

      if (type === 'task_attempt' && aid) {
        // Backend signals "agent X is about to start work" before the LLM call.
        // Replaces the prior auction_best_bid-only trigger so this fires
        // uniformly for every agent invocation.
        //
        // task_attempt marks a NEW ROUND of work for this agent. Any prior
        // thinking[aid] / writing[aid] is stale relative to this round and
        // must be cleared, otherwise the pending panel never shows. Concrete
        // case: human_expert evaluates auction bids first, which produces a
        // ~4ms agent.streaming.thinking.delta + .done with phase="bidding".
        // My useMemo keeps thinking[human_expert] with status='done' through
        // the streaming.closed (intentional — it's the "thought for [N.Ns]"
        // collapsed bubble). Then task_attempt fires for human_expert's real
        // work, but the old guard `if (!thinking[aid] && !writing[aid])`
        // sees the bidding residue and skips setting pending. Result on
        // project 7fbf6a56-...: empty AI avatar for the entire upstream
        // buffering window with no agent indicator at all.
        delete thinking[aid]
        delete writing[aid]
        pending[aid] = { startedAt: eventEmittedAtMs(e) }
      } else if (type === 'agent.streaming.round.retry' && aid) {
        // AppFactory-316: backend discarded partial stream for this attempt; clear
        // live writing/thinking so the next deltas do not append to attempt 1.
        delete thinking[aid]
        delete writing[aid]
        pending[aid] = {
          startedAt: eventEmittedAtMs(e),
          reason: 'provider_retry',
          attempt: e?.data?.attempt,
          maxAttempts: e?.data?.max_attempts,
        }
      } else if (type === 'agent.streaming.thinking.delta' && aid) {
        delete pending[aid]
        const content = e?.data?.content || ''
        const prevAgent = thinking[aid] || {}
        thinking[aid] = {
          ...prevAgent,
          content: (prevAgent.content || '') + content,
          status: 'thinking',
          startedAt: prevAgent.startedAt || eventEmittedAtMs(e),
        }
      } else if (type === 'agent.streaming.thinking.done' && aid) {
        delete pending[aid]
        const prevAgent = thinking[aid] || {}
        const startedAt = prevAgent.startedAt || eventEmittedAtMs(e)
        const elapsed = (eventEmittedAtMs(e) - startedAt) / 1000
        thinking[aid] = {
          ...prevAgent,
          // Prefer accumulated delta content; fall back to the done payload
          // (the buffered-thinking case from non-streaming upstream models —
          // see project 21ee263f investigation).
          content: prevAgent.content || e?.data?.content || '',
          status: 'done',
          startedAt,
          thinkingTime: Math.max(0, Math.round(elapsed * 10) / 10),
        }
      } else if (type === 'agent.streaming.text.delta' && aid) {
        delete pending[aid]
        delete thinking[aid]
        const content = e?.data?.content || ''
        const cur = writing[aid] || {}
        writing[aid] = {
          content: (cur.content || '') + content,
          startedAt: cur.startedAt || eventEmittedAtMs(e),
        }
      } else if (
        (type === 'agent.streaming.text.done' ||
          type === 'agent.streaming.terminated' ||
          type === 'agent.streaming.closed') &&
        aid
      ) {
        delete pending[aid]
        delete writing[aid]
        // Keep thinking[aid] if it has status='done' so the collapsed
        // "thought for [N.Ns]" bubble persists. Drop it only if it's still
        // 'thinking' (closed before completion — rare, but covers it).
        if (thinking[aid]?.status === 'thinking') {
          delete thinking[aid]
        }
      } else if (
        type === 'project_completed' ||
        type === 'approval_requested' ||
        type === 'phase.execution.completed' ||
        type === 'project_reverted'
      ) {
        for (const k of Object.keys(thinking)) delete thinking[k]
        for (const k of Object.keys(writing)) delete writing[k]
        for (const k of Object.keys(pending)) delete pending[k]
      }

      // Catch-all: ANY agent.streaming.* event for an agent means it has
      // moved past "waiting for first chunk" — clear pending. Without this,
      // agents like coding_agent that go straight from task_attempt to
      // tool_call.start (no thinking, no text) keep the pending panel up
      // for the entire tool-execution sequence — verified on project
      // 1e2602ac-... where coding_agent ran tools for 1m 15s while the UI
      // showed "Coding Agent is processing... Waiting for first response
      // chunk from upstream model." That message was a lie: the agent had
      // already produced 24 tool_call events. The specific branches above
      // (thinking.delta, text.delta, etc.) handle their own state too;
      // this catch-all only ensures pending is cleared regardless of
      // which streaming sub-type fired first.
      //
      // Exception: round.retry is itself a "waiting for next attempt" state
      // (AppFactory-316 backoff 1/5/20s). Clearing pending here left an empty
      // panel + a stale streaming.error strip during sleep.
      if (
        aid &&
        type.startsWith('agent.streaming.') &&
        type !== 'agent.streaming.round.retry' &&
        pending[aid]
      ) {
        delete pending[aid]
      }
    }

    return { agentsThinking: thinking, agentsWriting: writing, agentsPending: pending }
  }, [recentEvents])

  // User-toggled expansion for collapsed thought bubbles. Separate from the
  // derived state above because the user choice is local and shouldn't be
  // overwritten on every event. Default expanded for 'done' thoughts; this
  // set tracks which ones the user has explicitly collapsed.
  const [collapsedThoughts, setCollapsedThoughts] = useState(() => new Set())
  const isExpanded = (aid) => !collapsedThoughts.has(aid)
  const toggleExpanded = (aid) => {
    setCollapsedThoughts(prev => {
      const next = new Set(prev)
      if (next.has(aid)) next.delete(aid)
      else next.add(aid)
      return next
    })
  }

  const scrollRefsRef = useRef({})
  const writingScrollRefsRef = useRef({})
  // 1Hz re-render so the elapsed timers tick. The displayed elapsed value
  // is computed from event-derived `startedAt` on each render, so the
  // stopwatch is stable across remounts (event timestamps don't change).
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNowTick(t => (t + 1) % 1_000_000), 1000)
    return () => clearInterval(id)
  }, [])

  // Auto-scroll each agent's writing content as new deltas append.
  useEffect(() => {
    for (const aid of Object.keys(agentsWriting)) {
      const el = writingScrollRefsRef.current[aid]
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [agentsWriting])

  // Auto-scroll each agent's thinking content as new deltas append.
  useEffect(() => {
    for (const [aid, state] of Object.entries(agentsThinking)) {
      if (state.status === 'thinking') {
        const el = scrollRefsRef.current[aid]
        if (el) el.scrollTop = el.scrollHeight
      }
    }
  }, [agentsThinking])

  const status = (project?.status || '').toLowerCase()
  const phaseLower = (project?.current_phase || '').toLowerCase()
  const nonExecStatuses = new Set(['', 'initialized', 'cancelled', 'failed', 'completed'])
  const terminalStatuses = new Set(['cancelled', 'failed', 'completed'])
  const effectiveExecuting = !!(isExecuting && !pendingApproval && !nonExecStatuses.has(status))
  // The project is logically running whenever its status is not terminal and
  // not just-initialized. We can't trust `isExecuting` alone here — the
  // ExecutionMonitor flips it off after 8s of event silence, but legitimate
  // gaps between phases (e.g. between thinking.done and the next phase
  // starting) regularly exceed that window. Without this fallback the panel
  // hides entirely and the user sees a stale "Ready" with no indicator.
  const projectIsRunning = !!status && !terminalStatuses.has(status) && status !== 'initialized' && status !== 'idle'

  // Find current activity - just ONE item
  const currentItem = (() => {
    try {
      const list = Array.isArray(recentEvents) ? recentEvents : []
      const start = Math.max(0, list.length - 50)

      // Pre-scan for resolved approvals before the wait-state lookup. Without
      // this, currentItem keeps returning a stale approval_requested event
      // even after its approval_given fired for the same approval_id.
      // Verified on project 630e2e9b-1fd9-4fd2-b4a3-ac136ec49a82:
      //   18:42:38.142  approval_requested   id=5575227c  "Review requirements"
      //   18:43:12.999  approval_given       id=5575227c  status=approved
      //   18:43:43.926  approval_requested   id=7ac16805  "Review plan"
      // Screenshot at ~18:43:49 (5s after the new gate fired) showed
      // "Awaiting approval: Review requirements [37s]" because the new event
      // hadn't reached recentEvents over SSE yet AND isApprovalWait did no
      // resolution check, so the original approval_requested kept matching.
      // pendingApproval is the canonical "is there an unresolved gate?"
      // signal but doesn't carry a UI-renderable event with gate_type, so we
      // still need a non-stale event from recentEvents — hence this filter.
      // approval_given resolves a gate (user picked approve/reject).
      // approval_updated does NOT — it just refreshes the gate's content
      // (e.g. planner refined a plan after feedback); user still has to act.
      // Including approval_updated here previously made phase 1 skip the
      // refreshed gate state entirely, so after a re-plan the bottom strip
      // fell through to stale task_attempt / phase.X.started events with
      // their old stopwatches still climbing — verified on project 2bbc159e.
      // isApprovalWait now also matches approval_updated, so the backward
      // scan below picks up the latest refreshed approval state directly.
      // Phase 0: intent classifier in progress. Higher priority than the
      // approval_wait phase below because the system has already transitioned
      // from "waiting for user" → "processing user's input"; leaving the
      // strip on "Awaiting approval" during the 20-30s classifier roundtrip
      // looks frozen — verified on project 2bbc159e (backend.log:498-500
      // shows the classifier HTTP roundtrip alone took 30s). Resolves when
      // the matching intent_routing_completed fires.
      let lastIntentStartedIdx = -1
      let lastIntentCompletedIdx = -1
      for (let i = 0; i < list.length; i++) {
        const t = list[i]?.type || ''
        if (t === 'intent_routing_started') lastIntentStartedIdx = i
        else if (t === 'intent_routing_completed') lastIntentCompletedIdx = i
      }
      if (lastIntentStartedIdx >= 0 && lastIntentStartedIdx > lastIntentCompletedIdx) {
        return list[lastIntentStartedIdx]
      }

      const resolvedApprovalIds = new Set()
      for (let i = 0; i < list.length; i++) {
        const t = list[i]?.type || ''
        if (t === 'approval_given') {
          const aid = list[i]?.data?.approval_id
          if (aid) resolvedApprovalIds.add(aid)
        }
      }

      for (let i = list.length - 1; i >= start; i--) {
        if (isApprovalWait(list[i])) {
          const aid = list[i]?.data?.approval_id
          if (aid && resolvedApprovalIds.has(aid)) continue
          return list[i]
        }
      }

      // Pre-compute staleness signals used by phase 2 below. Phase 4 has its
      // own copy of `projectTerminated` and per-agent resolution tracking,
      // but phase 2 used to return the most recent tool_executed /
      // agent.streaming.tool_call.* without any check — so on project
      // ad25ded2 the bottom strip stuck on "Tool read completed [15m 51s]"
      // for 16 minutes past project_completed at 11:46:25 (the BE flipped
      // status="completed" but the FE didn't refetch the project doc, so
      // LiveActivity.visible() stayed true and phase 2 kept resurfacing the
      // last tool_executed from coding_agent at 11:45:38). The FE refetch
      // is now fixed in useProjectEvents.js project_completed handler; this
      // is defense-in-depth: even if the strip is visible for some other
      // reason, don't pin it to a tool event whose agent already streamed
      // text.done / closed / terminated, and never pin it to one at all
      // once the project is terminated.
      const phase2_projectTerminated = list.some(e => {
        const t = e?.type || ''
        return t === 'project_completed' || t === 'project_reverted' || t === 'project_failed' || t === 'project_cancelled'
      })
      const phase2_agentMovedOnAt = new Map()
      for (let i = 0; i < list.length; i++) {
        const t = list[i]?.type || ''
        const aid = list[i]?.data?.agent_id
        if (!aid) continue
        if (t === 'agent.streaming.closed' || t === 'agent.streaming.terminated' || t === 'agent.streaming.text.done') {
          if ((phase2_agentMovedOnAt.get(aid) ?? -1) < i) phase2_agentMovedOnAt.set(aid, i)
        }
      }
      // A task_attempt is stale if its agent has produced a terminal
      // streaming event (closed / terminated / text.done) at a LATER index.
      // Without this, phase 3 returns task_attempts whose agent finished long
      // ago — verified on project 2bbc159e where the replan task_attempt at
      // index 53 pinned the bottom strip even after planner.streaming.closed
      // at index 58 marked the agent done.
      const isStaleTaskAttempt = (e, index) => {
        const aid = e?.data?.agent_id
        if (!aid) return false
        const movedAt = phase2_agentMovedOnAt.get(aid) ?? -1
        return movedAt > index
      }
      // phase2_projectTerminated and phase2_agentMovedOnAt above were computed
      // to gate phase 4 (the comment at line ~336 says so explicitly), but
      // before this fix the filter was applied only to phase 5's
      // isStaleTaskAttempt. The tool-event loop returned the most recent
      // match unconditionally, which meant after a coding agent finished its
      // execution-phase work (closed via text.done at index N), its prior
      // tool_call.result at index N-K still pinned the strip — even after
      // phase.execution.completed fired and the project moved to deployment.
      // Verified on project 553a8aed-... where the strip read "Tool read
      // completed [21s]" 30s into the deployment phase, sourced from
      // coding_agent's last execution-phase tool_call.result.
      for (let i = list.length - 1; i >= start; i--) {
        if (phase2_projectTerminated) break
        const t = list[i]?.type || ''
        const aid = list[i]?.data?.agent_id
        if (aid && (phase2_agentMovedOnAt.get(aid) ?? -1) > i) continue
        if (t === 'agent.streaming.round.retry') return list[i]
        if (t === 'agent.streaming.error' || t === 'agent.streaming.tool_call.error') return list[i]
        if (t === 'agent.streaming.tool_call.executing' || t === 'agent.streaming.tool_call.start' || t === 'agent.streaming.tool_call.result') return list[i]
        if (t === 'tool_executed') return list[i]
        // text.delta/text.done are intentionally not currentItem candidates.
        // Live writing is rendered by the per-agent agentsWriting panel
        // (whose presence suppresses the status line at all). text.done is a
        // terminal marker — after an agent finishes writing it persists in
        // recentEvents forever, and pinning the strip to it pins to a
        // historical event (e.g. losing bidder critic_expert's text.done
        // remained the most-recent phase-4 hit for ~3 minutes while planner
        // waited on its first upstream chunk — verified on project
        // 17ffbbfa). Fall through to phase 5 (task_attempt) or phase 6
        // (in-progress event scan, e.g. auction_started, phase.X.started).
      }

      for (let i = list.length - 1; i >= start; i--) {
        if ((list[i]?.type || '') !== 'task_attempt') continue
        if (isStaleTaskAttempt(list[i], i)) continue
        return list[i]
      }
      // Build sets of "resolved" started-events so we don't return ones that
      // have been completed by a later event. Without this filter, the
      // currentItem loop below picks up auction_bid_started from minutes ago
      // and pins the bottom status line + stopwatch to "Bid started: X [Nm Ns]"
      // for the entire idle gap between agents — verified on project
      // e7b5e041-... where the user saw 1m 26s of stuck "Bid started:
      // Requirements Finalizer..." while three agents had already run.
      //
      // Resolution rules:
      //   - auction_completed clears every auction_bid_started (auction is over).
      //   - auction_bid_{completed,failed,timeout} for an agent clears
      //     auction_bid_started for the same agent.
      //   - Any agent.streaming.* for an agent clears auction_bid_started
      //     for that agent (the agent already moved past bidding).
      //   - For any other *_started event (e.g. deploy_started), a sibling
      //     event sharing the same root with suffix _succeeded / _failed /
      //     _completed / _finished marks it stale. Without this, the bottom
      //     line stayed "deploy started [N s]" indefinitely after a
      //     successful deploy — verified on project 21b8c9e1 where
      //     deploy_succeeded fired 20s after deploy_started but the panel
      //     still rendered "deploy started [35s]" 30s past project_completed.
      //   - Same shape for phase.X.started ↔ phase.X.completed pairs.
      //   - project_completed / project_reverted clear every started event
      //     of either flavor — once the project is done, nothing started
      //     before that moment is still in progress by definition.
      // Pairs are matched by root, never by hardcoded event name, so adding
      // a future build_started/build_succeeded pair on the BE works without
      // any FE change.
      const auctionTerminated = list.some(e => (e?.type || '') === 'auction_completed')
      const bidsResolvedByAgent = new Set()
      const TERMINATOR_SUFFIXES = ['_succeeded', '_failed', '_completed', '_finished']
      const resolvedStartedRoots = new Set()
      const resolvedPhaseRoots = new Set()
      let projectTerminated = false
      for (const e of list) {
        const t = e?.type || ''
        const aid = e?.data?.agent_id
        if (aid && (
          t === 'auction_bid_completed' ||
          t === 'auction_bid_failed' ||
          t === 'auction_bid_timeout' ||
          t.startsWith('agent.streaming.')
        )) {
          bidsResolvedByAgent.add(aid)
        }
        if (t === 'project_completed' || t === 'project_reverted' || t === 'project_failed' || t === 'project_cancelled') {
          projectTerminated = true
          continue
        }
        if (t.startsWith('phase.') && t.endsWith('.completed')) {
          resolvedPhaseRoots.add(t.slice(0, -'.completed'.length))
          continue
        }
        for (const suf of TERMINATOR_SUFFIXES) {
          if (t.length > suf.length && t.endsWith(suf)) {
            resolvedStartedRoots.add(t.slice(0, -suf.length))
            break
          }
        }
      }
      const isStaleStarted = (e, index) => {
        const t = e?.type || ''
        if (projectTerminated && (t.endsWith('_started') || t.endsWith('.started'))) {
          return true
        }
        if (t === 'auction_bid_started') {
          if (auctionTerminated) return true
          const aid = e?.data?.agent_id
          if (aid && bidsResolvedByAgent.has(aid)) return true
        }
        if (t.startsWith('phase.') && t.endsWith('.started')) {
          if (resolvedPhaseRoots.has(t.slice(0, -'.started'.length))) return true
        } else if (t.endsWith('_started')) {
          if (resolvedStartedRoots.has(t.slice(0, -'_started'.length))) return true
        }
        // task_attempt is "in progress" per isInProgress, but its resolution
        // signal is agent.streaming.{closed,text.done,terminated} for the same
        // agent — handled by isStaleTaskAttempt above. Phase 3 filters
        // task_attempts via isStaleTaskAttempt and falls through when all are
        // stale. Without delegating here, phase 4's backward "any in-progress"
        // scan picks up the same stale task_attempt phase 3 just rejected and
        // returns it, pinning the bottom strip to "Task: Re-plan based on
        // user feedback attempt 1 by Task Planner [N s]" indefinitely after
        // the planner's streaming.closed fires — verified on project
        // 2bbc159e where the replan task_attempt at event index 53 had
        // agent.streaming.closed for planner at index 58 marking it
        // resolved, yet the strip stuck on it until phase planning ended.
        if (t === 'task_attempt' && isStaleTaskAttempt(e, index)) return true
        return false
      }
      for (let i = list.length - 1; i >= start; i--) {
        if (isStaleStarted(list[i], i)) continue
        if (isInProgress(list[i])) return list[i]
      }
    } catch {}
    return null
  })()

  const hasAnyThinking = Object.keys(agentsThinking).length > 0
  const hasAnyWriting = Object.keys(agentsWriting).length > 0
  const hasAnyPending = Object.keys(agentsPending).length > 0

  const isIdleInitialized = (
    (status === 'idle' || nonExecStatuses.has(status)) &&
    !pendingApproval && !effectiveExecuting && !isReverting && !isLoading && !currentItem
    && !hasAnyWriting
  )

  // ---------------------------------------------------------------------
  // Status-line stopwatch
  // ---------------------------------------------------------------------
  // We compute a stable "key" for the current status — when it changes, the
  // user has transitioned to a new state and the timer resets. The ref holds
  // the wall-clock instant the current state was entered, so the displayed
  // elapsed time is correct even across re-renders triggered by other things.
  // Both the key AND the started-at instant come from event data, not from
  // Date.now() at mount time. This is what makes the stopwatch survive a
  // tab switch — the event timestamps don't change just because the
  // component remounted. The previous implementation kept statusStartedAtRef
  // as a useRef(Date.now()) which reset every remount; the user verified by
  // switching from chat → events → chat and observing the timer reset to 0s.
  const phaseStartedAtMs = useMemo(() => {
    const list = Array.isArray(recentEvents) ? recentEvents : []
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i]?.type || ''
      if (t.startsWith('phase.') && t.endsWith('.started')) {
        return eventEmittedAtMs(list[i])
      }
    }
    return null
  }, [recentEvents])

  let statusKey, statusStartedAtMs
  if (hasAnyWriting) {
    const oldest = Math.min(...Object.values(agentsWriting).map(s => s.startedAt || Date.now()))
    statusKey = `writing:${oldest}`
    statusStartedAtMs = oldest
  } else if (currentItem) {
    const eid = currentItem.id || currentItem?.data?.timestamp || currentItem.timestamp || currentItem.type || 'unknown'
    statusKey = `event:${eid}`
    statusStartedAtMs = eventEmittedAtMs(currentItem)
  } else if (pendingApproval) {
    const aid = pendingApproval?.id || pendingApproval?.data?.timestamp || 'pending'
    statusKey = `approval:${aid}`
    statusStartedAtMs = eventEmittedAtMs(pendingApproval)
  } else if (status === 'creating') {
    statusKey = 'creating'
    statusStartedAtMs = null // no meaningful event-derived start; hide elapsed
  } else if (status === 'completed' || status === 'cancelled' || status === 'failed') {
    statusKey = `terminal:${status}`
    statusStartedAtMs = null
  } else if (projectIsRunning) {
    statusKey = `phase:${phaseLower || 'unknown'}`
    statusStartedAtMs = phaseStartedAtMs
  } else {
    statusKey = 'idle'
    statusStartedAtMs = null
  }
  // Hide stopwatch on truly idle / terminal — there's nothing to time.
  const showStatusElapsed = !statusKey.startsWith('terminal:') && statusKey !== 'idle' && statusStartedAtMs != null
  const statusElapsedMs = statusStartedAtMs != null ? Math.max(0, Date.now() - statusStartedAtMs) : 0

  // While any per-agent panel (thinking or writing) is on screen, that
  // panel already names the agent + has its own stopwatch + shows the live
  // content. Anything we add to the bottom status line is duplication at
  // best and a contradiction at worst — see the screenshot where
  // "Awaiting your reply [20s]" was rendered while human_expert was
  // actively writing output. So when there's per-agent activity, return
  // null and let the JSX skip the status line entirely.
  const hasAgentActivity = hasAnyThinking || hasAnyWriting || hasAnyPending
  const getCurrentStatus = () => {
    if (hasAgentActivity) return null
    // No "awaiting your reply" branch here on purpose. See the long comment
    // in ChatInterface.jsx where the heuristic was removed: the requirements
    // workflow auto-runs human_expert (workflows.json:11) immediately after
    // the gatherer's questions card, so an inferred-from-message "awaiting"
    // state is wrong by definition. The only real user gate is
    // approval_requested → pendingApproval below.
    if (currentItem) return { icon: iconForEvent(currentItem), label: summarizeEvent(currentItem, project), cls: labelClassForEvent(currentItem) }
    if (pendingApproval) return { icon: <Clock className="w-4 h-4 text-amber-300" />, label: 'Awaiting approval', cls: 'text-amber-300' }
    if (status === 'creating') return { icon: <Loader className="w-4 h-4 text-blue-400 animate-spin" />, label: 'Starting...', cls: 'text-slate-200' }
    // Project is running but nothing concrete to display — surface phase
    // context with a spinner so the user can tell the system is working
    // through a transition rather than stalled. Only reached when no agent
    // panel is up; otherwise the panel above is the truth.
    if (projectIsRunning) {
      const phaseLabel = phaseLower
        ? `${phaseLower.charAt(0).toUpperCase()}${phaseLower.slice(1)}…`
        : 'Working…'
      return { icon: <Loader className="w-4 h-4 text-blue-400 animate-spin" />, label: phaseLabel, cls: 'text-slate-200' }
    }
    if (isIdleInitialized) return { icon: <Clock className="w-4 h-4 text-slate-400" />, label: isPrefillResume ? 'Ready — edit and Send' : 'Ready', cls: 'text-slate-400' }
    if (status === 'completed') return { icon: <Clock className="w-4 h-4 text-emerald-300" />, label: 'Project completed', cls: 'text-emerald-300' }
    if (status === 'cancelled') return { icon: <Clock className="w-4 h-4 text-slate-400" />, label: 'Project cancelled', cls: 'text-slate-400' }
    if (status === 'failed') return { icon: <Clock className="w-4 h-4 text-red-400" />, label: 'Project failed', cls: 'text-red-300' }
    return { icon: <Clock className="w-4 h-4 text-slate-400" />, label: 'Idle', cls: 'text-slate-400' }
  }

  const currentStatus = getCurrentStatus()
  const statusIcon = currentStatus?.icon
  const statusLabel = currentStatus?.label
  const statusCls = currentStatus?.cls

  const visible = (() => {
    // Hide once the project reaches a terminal status — the page-level status
    // badge already conveys "completed/cancelled/failed", no need to repeat.
    if (terminalStatuses.has(status)) return false
    if (pendingApproval || effectiveExecuting || hasAnyThinking || hasAnyWriting || hasAnyPending) return true
    if (projectIsRunning) return true
    if (status === 'initialized' || status === 'creating') return true
    return false
  })()

  if (!visible) return null

  // Stable ordering: by startedAt so boxes don't jump around when state updates.
  const sortedAgents = Object.entries(agentsThinking).sort(
    (a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0)
  )
  const concurrentCount = sortedAgents.filter(([, s]) => s.status === 'thinking').length

  return (
    <div className={`flex gap-4 ${hasAnyThinking || hasAnyPending ? 'items-start' : 'items-center'}`}>
      {/* AI avatar */}
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-sm font-semibold text-white">
        AI
      </div>

      <div className="flex-1 min-w-0">
        {/* Per-agent "pending" panel — agent won auction but no streaming
            event has arrived yet (silent upstream gap). Sits above the
            thinking/writing panels so it's the first thing the user sees in
            the silent period. Cleared the moment any agent.streaming.* event
            for the agent fires. */}
        {hasAnyPending && (
          <div className="mb-2 space-y-2">
            {Object.entries(agentsPending).map(([aid, state]) => (
              <div key={`pending-${aid}`} className="bg-slate-800/50 rounded-lg p-3 border border-purple-700/40">
                <div className="flex items-center gap-2 mb-1">
                  <Loader className="w-4 h-4 text-purple-400 animate-spin" />
                  <span className="text-xs text-purple-300">
                    {formatAgentName(aid)} is processing...
                  </span>
                  {state.startedAt && (
                    <span className="text-sm font-mono font-semibold text-purple-200 tabular-nums">
                      [{formatElapsed(Date.now() - state.startedAt)}]
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400 italic">
                  {state.reason === 'provider_retry'
                    ? (
                      state.attempt != null && state.maxAttempts != null
                        ? `Provider retry ${state.attempt}/${state.maxAttempts} — waiting for next stream attempt.`
                        : 'Provider retry — waiting for next stream attempt.'
                    )
                    : 'Waiting for first response chunk from upstream model.'}
                </div>
              </div>
            ))}
          </div>
        )}

        {sortedAgents.length > 0 && (
          <div className="mb-2 space-y-2">
            {concurrentCount > 1 && (
              <div className="text-[11px] text-purple-300/80 font-mono uppercase tracking-wide">
                {concurrentCount} agents thinking in parallel
              </div>
            )}
            {sortedAgents.map(([aid, state]) => (
              <div key={aid}>
                {state.status === 'thinking' ? (
                  <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/60">
                    <div className="flex items-center gap-2 mb-2">
                      <Loader className="w-4 h-4 text-purple-400 animate-spin" />
                      <span className="text-xs text-purple-300">
                        {formatAgentName(aid)} thinking...
                      </span>
                      {state.startedAt && (
                        <span className="text-sm font-mono font-semibold text-purple-200 tabular-nums">
                          [{formatElapsed(Date.now() - state.startedAt)}]
                        </span>
                      )}
                    </div>
                    <div
                      ref={el => { if (el) scrollRefsRef.current[aid] = el }}
                      className={`${concurrentCount > 1 ? 'h-24' : 'h-32'} overflow-y-auto`}
                    >
                      <div className="text-sm text-slate-300 whitespace-pre-wrap break-words">
                        {state.content}
                        <span className="animate-pulse text-purple-400">▌</span>
                      </div>
                    </div>
                  </div>
                ) : state.thinkingTime > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(aid)}
                    className="text-left w-full"
                  >
                    <div className="flex items-center gap-2 text-xs text-purple-300 hover:text-purple-200">
                      <Brain className="w-3 h-3" />
                      <span>{formatAgentName(aid)} thought for <span className="font-mono font-semibold text-purple-200">[{state.thinkingTime}s]</span></span>
                      {isExpanded(aid) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </div>
                    {isExpanded(aid) && (
                      <div className="mt-2 bg-slate-800/50 rounded-lg p-3 max-h-48 overflow-y-auto">
                        <div className="text-sm text-slate-300 whitespace-pre-wrap break-words">
                          {state.content}
                        </div>
                      </div>
                    )}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* Per-agent live writing-output panels. Mirrors the thinking panel
            shape but green-tinted to make the phase distinguishable, and
            renders the actual streamed content so the user sees what the
            agent is producing in real time — not a generic placeholder. */}
        {Object.entries(agentsWriting).length > 0 && (
          <div className="mb-2 space-y-2">
            {Object.entries(agentsWriting).length > 1 && (
              <div className="text-[11px] text-emerald-300/80 font-mono uppercase tracking-wide">
                {Object.entries(agentsWriting).length} agents writing in parallel
              </div>
            )}
            {Object.entries(agentsWriting).map(([aid, state]) => (
              <div key={`writing-${aid}`} className="bg-slate-800/50 rounded-lg p-3 border border-emerald-700/40">
                <div className="flex items-center gap-2 mb-2">
                  <Loader className="w-4 h-4 text-emerald-400 animate-spin" />
                  <span className="text-xs text-emerald-300">
                    {formatAgentName(aid)} writing output...
                  </span>
                  {state.startedAt && (
                    <span className="text-sm font-mono font-semibold text-emerald-200 tabular-nums">
                      [{formatElapsed(Date.now() - state.startedAt)}]
                    </span>
                  )}
                </div>
                <div
                  ref={el => { if (el) writingScrollRefsRef.current[aid] = el }}
                  className={`${Object.entries(agentsWriting).length > 1 ? 'h-24' : 'h-32'} overflow-y-auto`}
                >
                  <div className="text-sm text-slate-300 whitespace-pre-wrap break-words font-mono">
                    {state.content}
                    <span className="animate-pulse text-emerald-400">▌</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Current status — omitted entirely when there's already a per-agent
            panel (thinking/writing) above. The panel covers the same ground
            with its own stopwatch and live content; a second status line
            below it would duplicate or contradict (e.g. "Awaiting your reply"
            shown while an agent is actively writing output). */}
        {currentStatus && (
          <div className="flex items-center gap-2 text-sm">
            {statusIcon}
            <span className={statusCls}>{statusLabel}</span>
            {showStatusElapsed && (
              <span className="text-sm font-mono font-semibold text-slate-200 tabular-nums">
                [{formatElapsed(statusElapsedMs)}]
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
