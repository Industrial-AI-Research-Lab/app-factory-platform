import { useState, useRef, useEffect, useMemo } from 'react'
import { Activity } from 'lucide-react'
import { apiFetch } from '../utils_api'
import { notify } from '../utils_notify'
import { timestampMs } from '../utils_time'
import ConfirmDialog from './ConfirmDialog'
import { LiveActivity, AttachmentComposer } from './chat'
import ChatMessageList from './chat/ChatMessageList'
import { buildToolJournalIndex } from './chat/toolJournalUtils'
import { useMessages } from '../hooks/useMessages'
import useApprovalRefresh from '../hooks/useApprovalRefresh'
import { useAgentInvocations, resolveCaptureForThought, resolveCapturesForAgent } from '../hooks/useAgentInvocations'
import {
  buildMessageSendFormData,
  canSendChatPayload,
} from '../utils/attachmentFiles'
import { saveRevertDraft, takeRevertDraft } from '../utils/revertEffects'

/**
 * Extract completed thoughts from events for injection into chat
 * Uses backend timestamp from event data for accurate ordering
 */
function extractCompletedThoughts(events) {
  if (!events?.length) return []

  // Build a map of usage by agent_id + round for Responses API events
  const usageMap = new Map()
  events.filter(e => e?.type === 'agent.streaming.usage').forEach(e => {
    const key = `${e.data?.agent_id || 'unknown'}-${e.data?.round || 1}`
    usageMap.set(key, e.data?.usage)
  })

  // Termination signals: collect timeouts (from auction) and stream-terminated
  // events (from base.py streaming wrapper). We'll match each thought against
  // the latest termination event for its agent that fell within ±15s of the
  // thought's end. 15s is a generous window covering: (a) the natural gap
  // between thinking.done and the post-thinking output emission, and (b) the
  // orphan-stream case where the auction times out at 10s but the inner LLM
  // call drags on a few extra seconds before its thinking.done finally fires.
  const eventTimeMs = (e) => {
    const ts = e?.data?.timestamp
    if (typeof ts === 'string') {
      const head = ts.split('-')[0]
      const f = parseFloat(head)
      if (Number.isFinite(f)) return f * 1000
    }
    if (e?.timestamp instanceof Date) return e.timestamp.getTime()
    if (e?.timestamp) return new Date(e.timestamp).getTime()
    return 0
  }
  const terminations = events
    .filter(e => e?.type === 'agent.validation.timeout' || e?.type === 'agent.streaming.terminated')
    .map(e => ({
      agentId: e.data?.agent_id,
      reason: e.type === 'agent.validation.timeout'
        ? 'auction timed out'
        : (e.data?.reason || 'cancelled'),
      timeMs: eventTimeMs(e),
    }))

  // Wire elapsed signals: pair each thinking.done with the agent's nearest
  // stream.closed (natural) or stream.terminated (exception) within ±15s.
  // `elapsed` is the backend STREAM.start→STREAM.end interval in seconds and
  // is the only honest "how long did the model actually work" measure when
  // the provider buffered the response into a single SSE chunk (thinking_time
  // collapses to ~0 in that case).
  const closures = events
    .filter(e => e?.type === 'agent.streaming.closed' || e?.type === 'agent.streaming.terminated')
    .map(e => ({
      agentId: e.data?.agent_id,
      elapsedS: typeof e.data?.elapsed === 'number' ? e.data.elapsed : null,
      timeMs: eventTimeMs(e),
    }))

  // Walk events in order to attach a deltaCount to each thinking.done — the
  // count of thinking.delta events that preceded it for the same agent since
  // its previous thinking.done. deltaCount===1 with a non-trivial wire elapsed
  // is the signature of a provider-buffered response: the model worked for N
  // seconds and then dumped the full result in one chunk.
  const deltaCountByDoneIdx = new Map()
  {
    const runningByAgent = new Map()
    let doneIdx = 0
    for (const e of events) {
      const t = e?.type
      const aid = e?.data?.agent_id
      if (!aid) continue
      if (t === 'agent.streaming.thinking.delta') {
        runningByAgent.set(aid, (runningByAgent.get(aid) || 0) + 1)
      } else if (t === 'agent.streaming.thinking.done') {
        deltaCountByDoneIdx.set(doneIdx, runningByAgent.get(aid) || 0)
        runningByAgent.set(aid, 0)
        doneIdx += 1
      }
    }
  }

  // Drop thinking.done only for the same streaming attempt as round.retry
  // (same `round`, after task_attempt). Never erase prior-round / bidding thoughts
  // when the failed attempt died before its own thinking.done (AppFactory-316).
  const suppressedDoneIdx = new Set()
  {
    const lastDoneByAgent = new Map()
    let doneIdx = 0
    for (const e of events) {
      const t = e?.type
      const aid = e?.data?.agent_id
      if (!aid) continue
      if (t === 'task_attempt') {
        lastDoneByAgent.delete(aid)
      } else if (t === 'agent.streaming.thinking.done') {
        lastDoneByAgent.set(aid, {
          idx: doneIdx,
          round: e.data?.round ?? null,
        })
        doneIdx += 1
      } else if (t === 'agent.streaming.round.retry') {
        const prev = lastDoneByAgent.get(aid)
        if (prev == null) continue
        const retryRound = e.data?.round ?? null
        if (prev.round != null && retryRound != null) {
          if (Number(prev.round) === Number(retryRound)) {
            suppressedDoneIdx.add(prev.idx)
            lastDoneByAgent.delete(aid)
          }
        } else if (prev.round == null && retryRound == null) {
          suppressedDoneIdx.add(prev.idx)
          lastDoneByAgent.delete(aid)
        }
      }
    }
  }

  return events
    .filter(e => e?.type === 'agent.streaming.thinking.done')
    .map((e, idx) => {
      if (suppressedDoneIdx.has(idx)) return null
      // Use the backend timestamp from data, fallback to event timestamp
      const backendTs = e.data?.timestamp
      const eventTs = e.timestamp
      const thinkingTime = e.data?.thinking_time || 0
      
      // Parse backend timestamp (format: "1234567890.123-456" -> use the float part)
      let endTs = null
      if (backendTs && typeof backendTs === 'string') {
        const floatPart = backendTs.split('-')[0]
        if (floatPart) {
          endTs = new Date(parseFloat(floatPart) * 1000)
        }
      }
      if (!endTs || isNaN(endTs.getTime())) {
        endTs = eventTs instanceof Date ? eventTs : new Date(eventTs || Date.now())
      }
      
      // Calculate START time by subtracting thinking duration - this fixes ordering
      // so thoughts appear BEFORE the messages that come after them
      const startTs = new Date(endTs.getTime() - (thinkingTime * 1000))
      
      // Get usage from event data or from separate usage event (Responses API)
      const agentId = e.data?.agent_id || null
      const round = e.data?.round || 1
      const usageKey = `${agentId || 'unknown'}-${round}`
      const usage = e.data?.usage || usageMap.get(usageKey) || null
      
      // Find the latest termination event for this agent within ±15s of end.
      // Picking "latest" handles the case where multiple thoughts overlap — we
      // want the one that fired closest to (and after) this thought's end.
      let finishReason = null
      const endMs = endTs.getTime()
      let bestDelta = Infinity
      for (const t of terminations) {
        if (!t.agentId || t.agentId !== agentId) continue
        const delta = Math.abs(t.timeMs - endMs)
        if (delta > 15000) continue
        if (delta < bestDelta) {
          bestDelta = delta
          finishReason = t.reason
        }
      }

      // Find the matching closure (natural or terminated) — closest in time.
      let wireElapsedMs = null
      let bestClosureDelta = Infinity
      for (const c of closures) {
        if (!c.agentId || c.agentId !== agentId) continue
        if (c.elapsedS == null) continue
        const delta = Math.abs(c.timeMs - endMs)
        if (delta > 15000) continue
        if (delta < bestClosureDelta) {
          bestClosureDelta = delta
          wireElapsedMs = Math.round(c.elapsedS * 1000)
        }
      }

      // Buffered: only one delta arrived for this thought AND the wire took
      // long enough (>2s) that "one chunk" was clearly a provider choice, not
      // just a tiny response that fit in one packet. 2s threshold keeps fast
      // legitimate responses from being mis-flagged.
      const deltaCount = deltaCountByDoneIdx.get(idx) || 0
      const buffered = deltaCount === 1 && wireElapsedMs != null && wireElapsedMs >= 2000

      return {
        id: `thought-${backendTs || idx}`,
        type: 'thought',
        content: e.data?.content || '',
        thinkingTime: thinkingTime,
        agentId: agentId,
        phase: e.data?.phase || null,
        usage: usage,
        round: round,
        timestamp: startTs,  // Use START time for ordering
        finishedAt: endTs,   // Keep end time for display
        created_at: startTs.toISOString(),
        finishReason: finishReason,
        deltaCount: deltaCount,
        wireElapsedMs: wireElapsedMs,
        buffered: buffered,
        // Store original index for stable ordering within same second
        _eventIdx: idx,
      }
    })
    .filter(Boolean)
    // Dedup defense: two thinking.done events were observed in MongoDB for the
    // same (agent, round, content) on project 9636d4d7 — visible as side-by-
    // side duplicate "Human Expert thought" blocks where the first carried the
    // buffered label (thinking_time≈7.1s) and the second was [0.0s]. Root
    // cause is suspected in the LLM client streaming layer (two emission sites
    // both firing); a backend fix needs separate investigation. Until then,
    // collapse here using (agentId|round|first-128-chars-of-content) as the
    // key. The first occurrence wins — that's the one with real metrics.
    .reduce((acc, t) => {
      const key = `${t.agentId || '_'}|${t.round || 0}|${(t.content || '').slice(0, 128)}`
      if (!acc._seen) acc._seen = new Set()
      if (acc._seen.has(key)) {
        try {
          console.debug('[extractCompletedThoughts] dedup', { key, agentId: t.agentId, round: t.round, thinkingTime: t.thinkingTime })
        } catch {}
        return acc
      }
      acc._seen.add(key)
      acc.list.push(t)
      return acc
    }, { list: [], _seen: null }).list
}

/**
 * Merge messages and thoughts in chronological order
 * Thoughts are inserted based on their actual occurrence time
 */
function mergeMessagesAndThoughts(messages, thoughts) {
  if (!thoughts.length) return messages
  
  // Parse timestamps for comparison. Use the TZ-defensive helper: naive ISO
  // strings (legacy backend output) are treated as UTC so user messages don't
  // get sorted ahead of agent thoughts that ran earlier in real time.
  const getTime = (item) => {
    if (item.created_at) return timestampMs(item.created_at)
    if (item.timestamp) return item.timestamp instanceof Date ? item.timestamp.getTime() : timestampMs(item.timestamp)
    return 0
  }
  
  // Combine and sort by timestamp, with sequence as tiebreaker for messages
  const combined = [...messages, ...thoughts]
  combined.sort((a, b) => {
    const timeDiff = getTime(a) - getTime(b)
    if (Math.abs(timeDiff) > 1000) return timeDiff // More than 1s apart - use time
    // Within 1s - use sequence for messages, _eventIdx for thoughts
    const seqA = a.sequence ?? (a._eventIdx !== undefined ? 100000 + a._eventIdx : 0)
    const seqB = b.sequence ?? (b._eventIdx !== undefined ? 100000 + b._eventIdx : 0)
    return seqA - seqB
  })
  
  return combined
}

/**
 * ChatInterface - Unified Message System
 * 
 * All interactions are messages in a single ordered stream.
 * No complex reconstruction logic - just render messages by type.
 */
export default function ChatInterface({ 
  projectId, 
  project,
  onApprove, 
  onReject,
  isReverting = false,
  isExecuting = false,
  recentEvents = [],
  allEvents = [],
  prefillInput = '',
  messageResetNonce = 0,
  diagOpen = false,
  onToggleDiag,
}) {
  const [input, setInput] = useState(prefillInput || '')
  const [selectedFiles, setSelectedFiles] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [reqAnswers, setReqAnswers] = useState({})
  const [confirmState, setConfirmState] = useState({ open: false, title: '', message: '', confirmLabel: 'Confirm', variant: 'danger', onConfirm: null })
  const messagesEndRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)

  // Unified message system - single source of truth.
  // Pass the active run id so REST and SSE both scope to the current run on
  // fork/multi-run projects; otherwise useMessages would fetch project-wide
  // messages and the UI would mix runs (e.g. after RunsPanel.activateRun
  // swaps the active run, the chat would still show the previous run's
  // chat until reload). `current_run_id` is the storage-of-truth field from
  // /projects/{id}; `run_id` is the in-memory mirror set by activate_run.
  const activeRunId = project?.current_run_id || project?.run_id
  const { messages, pendingApproval, refetch } = useMessages(projectId, {
    runId: activeRunId,
    enableSSE: true,
    resetNonce: messageResetNonce,
  })
  
  useApprovalRefresh(recentEvents, projectId, activeRunId, refetch)

  // Index captured LLM invocations so each thought can offer the Inspector
  // drill-down (see AgentInvocationInspector.jsx).
  const invocations = useAgentInvocations(allEvents)

  // Extract completed thoughts from ALL events (not just recent 50)
  const completedThoughts = useMemo(() => {
    const thoughts = extractCompletedThoughts(allEvents)
    return thoughts.map(t => {
      const cap = resolveCaptureForThought(invocations, t.agentId, t.round)
      return cap ? { ...t, _capture: cap } : t
    })
  }, [allEvents, invocations])

  // Attach captured LLM invocations to each agent's text output so AssistantMessage
  // can offer the Inspector. Agents that stream text without any thinking block
  // (e.g. low reasoning_effort) have no thought bubble to host the Inspector, so
  // without this their invocations are unreachable from the chat.
  const messagesWithCaptures = useMemo(() => {
    if (!Array.isArray(messages)) return messages
    return messages.map(m => {
      if (m?.type !== 'assistant') return m
      const agentId = m.data?.agent_id
      if (!agentId) return m
      const caps = resolveCapturesForAgent(invocations, agentId)
      return caps.length ? { ...m, _captures: caps } : m
    })
  }, [messages, invocations])

  // Merge messages and thoughts in chronological order
  const allMessages = useMemo(() => {
    return mergeMessagesAndThoughts(messagesWithCaptures, completedThoughts)
  }, [messagesWithCaptures, completedThoughts])

  // Pair journal records across the whole stream (a result renders inside
  // its call's card; a call with no result shows as awaiting)
  const toolJournal = useMemo(() => buildToolJournalIndex(allMessages), [allMessages])

  // Update input when prefillInput changes
  useEffect(() => {
    if (prefillInput) setInput(prefillInput)
  }, [prefillInput])

  // Scroll to bottom on new messages
  const scrollToBottom = (behavior = 'smooth') => messagesEndRef.current?.scrollIntoView({ behavior })
  useEffect(() => {
    if (autoScrollEnabled) scrollToBottom('smooth')
  }, [allMessages, autoScrollEnabled])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const handleScroll = () => {
      const thresholdPx = 120
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setAutoScrollEnabled(distanceFromBottom <= thresholdPx)
    }

    handleScroll()
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [projectId])

  // Computed status
  const status = (project?.status || '').toLowerCase()
  const nonExecStatuses = new Set(['', 'initialized', 'cancelled', 'failed', 'completed'])
  const effectiveExecuting = !!(isExecuting && !pendingApproval && !nonExecStatuses.has(status))

  // Note: do NOT add an "awaitingUserReply" heuristic here based on
  // questions_generated / clarifying questions in the latest assistant
  // message. The requirements workflow (workflows.json:11) runs human_expert
  // with agent_selection="direct" immediately after requirements_gatherer
  // emits its questions card — backend.log shows the transition in 1ms
  // (18:49:36.440 STREAM.end gatherer → 18:49:36.441 STREAM.start
  // human_expert). There is no inline user-reply pathway in this phase.
  // The only legitimate user gate is approval_requested, surfaced via
  // pendingApproval. Any "awaiting reply" inferred from message content is
  // structurally wrong and will mis-label the LLM-warmup window between
  // agents.

  // Handle revert to a user message
  const handleRevert = (message) => {
    if (message.type !== 'user') {
      notify({ title: 'Cannot revert here', message: 'Revert is only available on user messages.', variant: 'info', ttl: 4000 })
      return
    }
    
    setConfirmState({
      open: true,
      title: 'Revert to this point?',
      message: 'This will stop the current execution and restore a prior snapshot.',
      confirmLabel: 'Revert',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmState(s => ({ ...s, open: false }))
        try {
          // Use message sequence directly (unified message system)
          const sequence = message.sequence
          
          if (!sequence) {
            notify({ title: 'Revert failed', message: 'Message has no sequence number', variant: 'error', ttl: 5000 })
            return
          }
          
          notify({ title: 'Reverting...', message: 'Restoring to this message', variant: 'info', ttl: 3000 })

          saveRevertDraft(projectId, message.content)
          const resp = await apiFetch(`/projects/${projectId}/revert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: { type: 'message_sequence', sequence }, resume: false })
          })
          // Dropped once the server answers, not in catch: a reload aborts this request, and the abort may still run catch.
          takeRevertDraft(projectId)

          if (!resp.ok) {
            const text = await resp.text()
            notify({ title: 'Revert failed', message: `${resp.status}: ${text}`.slice(0, 400), variant: 'error', ttl: 7000 })
          } else {
            notify({ title: 'Reverted', message: 'Checkpoint applied', variant: 'success', ttl: 2500 })
            setInput(message.content || '')
            refetch()
          }
        } catch (e) {
          notify({ title: 'Revert error', message: String(e), variant: 'error', ttl: 6000 })
        }
      }
    })
  }

  // Send message - unified handler for all user input
  const handleSend = async () => {
    const text = input.trim()
    const hasFiles = selectedFiles.length > 0
    if (!canSendChatPayload(text, selectedFiles) || isLoading) return

    setIsLoading(true)
    setInput('')
    setAutoScrollEnabled(true)
    scrollToBottom('auto')
    
    try {
      let resp
      if (hasFiles) {
        resp = await apiFetch(`/projects/${projectId}/messages`, {
          method: 'POST',
          body: buildMessageSendFormData(text, selectedFiles),
        })
      } else {
        // Send message via unified endpoint (JSON path)
        resp = await apiFetch(`/projects/${projectId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text })
        })
      }
      
      if (!resp.ok) {
        const errorText = await resp.text()
        throw new Error(`Server error (${resp.status}): ${errorText}`)
      }

      // Ensure message appears even if SSE is delayed/disconnected
      await refetch()
      setAutoScrollEnabled(true)
      scrollToBottom('smooth')

      if (hasFiles) {
        setSelectedFiles([])
      }
    } catch (error) {
      console.error('Failed to send message:', error)
      setInput(text)
      notify({ title: 'Send failed', message: String(error).slice(0, 400), variant: 'error', ttl: 6000 })
    } finally {
      setIsLoading(false)
    }
  }

  // Interrupt execution and send
  const handleInterruptSend = () => {
    const trimmed = input.trim()
    if (!canSendChatPayload(trimmed, selectedFiles) || isLoading) return
    
    setConfirmState({
      open: true,
      title: 'Stop, revert, and send this message?',
      message: 'This will stop the current execution, revert to your latest checkpoint, and send this message.',
      confirmLabel: 'Stop, Revert & Send',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmState(s => ({ ...s, open: false }))
        try {
          const resp = await apiFetch(`/projects/${projectId}/stop-and-revert-latest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Stop & revert from chat' })
          })
          if (!resp.ok) {
            const text = await resp.text()
            notify({ title: 'Stop + Revert failed', message: `${resp.status}: ${text}`.slice(0, 400), variant: 'error', ttl: 7000 })
            return
          }
          await handleSend()
        } catch (err) {
          notify({ title: 'Stop + Revert error', message: String(err), variant: 'error', ttl: 7000 })
        }
      }
    })
  }

  return (
    <div className="relative flex flex-col h-full">
      {isReverting && (
        <div className="absolute inset-0 z-20 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center">
          <div className="flex items-center gap-3 text-slate-200 text-sm bg-slate-800/80 border border-slate-700 rounded px-3 py-2">
            <Loader className="w-4 h-4 animate-spin text-blue-400" />
            Reverting project to earlier state...
          </div>
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
          <ChatMessageList
            key={JSON.stringify([projectId, activeRunId, messageResetNonce])}
            messages={allMessages}
            onApprove={onApprove}
            onReject={onReject}
            projectId={projectId}
            reqAnswers={reqAnswers}
            setReqAnswers={setReqAnswers}
            onRevert={handleRevert}
            refetchMessages={refetch}
            toolJournal={toolJournal}
          />
          
          {/* Concurrency / buffered-stream detection moved to DiagnosticDrawer
              (rendered at the page level in ExecutionMonitor). No in-chat banner
              so the chat surface stays clean; the drawer's edge handle pulses
              when an incident is detected. */}

          {/* Live activity - inline with chat messages */}
          <LiveActivity project={project} recentEvents={recentEvents} pendingApproval={pendingApproval} isExecuting={isExecuting} isReverting={isReverting} isLoading={isLoading} />
          
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-slate-700 pt-6 px-4">
        <div className="max-w-4xl mx-auto">
          <AttachmentComposer
            value={input}
            onChange={setInput}
            files={selectedFiles}
            onFilesChange={setSelectedFiles}
            onSubmit={effectiveExecuting ? handleInterruptSend : handleSend}
            placeholder="Send a message..."
            disabled={isLoading || isReverting}
            loading={isLoading}
            submitDisabled={(!input.trim() && selectedFiles.length === 0) || isLoading}
            submitMode={effectiveExecuting ? 'interrupt' : 'send'}
            footer={
              <div className="mt-3 flex items-center justify-center gap-3 text-xs text-slate-500">
                <span>Enter to send · Shift+Enter for new line</span>
                {onToggleDiag && (
                  <>
                    <span className="text-slate-700">·</span>
                    <button
                      type="button"
                      onClick={onToggleDiag}
                      title="Toggle diagnostic drawer (Ctrl+I) — live workflow state, streams, events"
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] transition-colors ${diagOpen ? 'border-blue-500/50 bg-blue-500/10 text-blue-200' : 'border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200'}`}
                    >
                      <Activity className="w-3 h-3" />
                      <span>{diagOpen ? 'Hide diagnostics' : 'Show diagnostics'}</span>
                      <span className="text-slate-600">Ctrl+I</span>
                    </button>
                  </>
                )}
              </div>
            }
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        variant={confirmState.variant}
        onConfirm={confirmState.onConfirm}
        onClose={() => setConfirmState(s => ({ ...s, open: false }))}
      />
    </div>
  )
}
