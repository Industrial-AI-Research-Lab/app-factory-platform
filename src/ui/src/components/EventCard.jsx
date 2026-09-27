import { useState } from 'react'
import { CheckCircle, XCircle, Clock, Loader, ChevronDown, ChevronRight, AlertTriangle, ChevronsDownUp } from 'lucide-react'
import { cleanAgentName } from '../utils/eventFacets'
import EventPrimaryLine from './EventPrimaryLine'

export default function EventCard({ event, index, allEvents = [], onRevertToLastUserAction }) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Check if a phase has completed (for started events)
  const isPhaseCompleted = (eventType) => {
    if (eventType.includes('phase.') && eventType.includes('.started')) {
      const phase = eventType.split('.')[1]
      return allEvents.some(e => e.type === `phase.${phase}.completed`)
    }
    return false
  }

  const approvalOutcome = (idx, data) => {
    try {
      const approvalId = data?.approval_id || data?.approvalId || data?.id
      if (!approvalId) return null
      const tail = Array.isArray(allEvents) ? allEvents.slice(Math.max(0, idx + 1)) : []
      for (const e of tail) {
        const et = e?.type || ''
        const ed = e?.data || {}
        if (et !== 'approval_given') continue
        const eid = ed?.approval_id || ed?.approvalId || ed?.id
        if (eid !== approvalId) continue
        const isApproved = ed?.status === 'approved' || ed?.approved === true
        return isApproved ? 'approved' : 'rejected'
      }
      return null
    } catch {
      return null
    }
  }

  const isAuctionCompleted = (eventType, idx) => {
    try {
      const t = String(eventType || '')
      if (!t.includes('auction') || !t.includes('started')) return false

      const tail = Array.isArray(allEvents) ? allEvents.slice(Math.max(0, idx + 1)) : []
      if (t.includes('bid')) {
        return tail.some(e => {
          const et = String(e?.type || '')
          return et.includes('auction') && et.includes('bid') && et.includes('completed')
        })
      }
      return tail.some(e => {
        const et = String(e?.type || '')
        return et.includes('auction') && !et.includes('bid') && et.includes('completed')
      })
    } catch {
      return false
    }
  }

  const isMostRecentTaskAttempt = (() => {
    try {
      if (!Array.isArray(allEvents) || allEvents.length === 0) return true
      for (let i = allEvents.length - 1; i >= 0; i -= 1) {
        if (allEvents[i]?.type === 'task_attempt') {
          return allEvents[i] === event
        }
      }
      return false
    } catch {
      return true
    }
  })()

  const isMostRecent = (() => {
    try {
      if (!Array.isArray(allEvents) || allEvents.length === 0) return true
      return allEvents[allEvents.length - 1] === event
    } catch {
      return true
    }
  })()

  const taskAttemptOutcome = (idx, data) => {
    try {
      const taskId = data?.task_id
      if (!taskId) return null
      const tail = Array.isArray(allEvents) ? allEvents.slice(Math.max(0, idx + 1)) : []
      for (const e of tail) {
        const et = e?.type || ''
        const ed = e?.data || {}
        if (ed?.task_id !== taskId) continue
        if (et === 'task_completed') return 'completed'
        if (et === 'task_failed') return 'failed'
      }
      return null
    } catch {
      return null
    }
  }

  // Determine event status and icon
  const getEventStatus = (evt, idx) => {
    const type = evt?.type || ''
    const data = evt?.data || {}
    // context_compaction fold markers: purple only when a fold actually happened —
    // pre_send (proactive) or overflow (reactive backstop); muted slate when merely
    // evaluated/skipped or per-turn/-tool bookkeeping, so real compaction stands out.
    if (type === 'plugin.marker') {
      const isFold = data?.hook === 'pre_send' || data?.hook === 'overflow'
      if (isFold && data?.compacted === true) {
        return { icon: <ChevronsDownUp className="w-5 h-5" />, color: 'text-purple-400', bg: 'bg-purple-900/20' }
      }
      const dim = isFold ? 'text-slate-400' : 'text-slate-500'
      return { icon: <ChevronsDownUp className="w-5 h-5" />, color: dim, bg: 'bg-slate-800' }
    }
    if (type === 'project_started') {
      return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
    }
    if (type === 'approval_given') {
      const isApproved = data?.status === 'approved' || data?.approved === true
      if (isApproved) {
        return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
      }
      return { icon: <XCircle className="w-5 h-5" />, color: 'text-orange-400', bg: 'bg-orange-900/20' }
    }
    if (type === 'approval_updated' || type.includes('requested') || type.includes('needed')) {
      const outcome = approvalOutcome(idx, data)
      if (outcome === 'approved') {
        return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
      }
      if (outcome === 'rejected') {
        return { icon: <XCircle className="w-5 h-5" />, color: 'text-orange-400', bg: 'bg-orange-900/20' }
      }
      return { icon: <AlertTriangle className="w-5 h-5" />, color: 'text-amber-400', bg: 'bg-amber-900/20' }
    }
    if (type === 'snapshot_created') {
      return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-slate-400', bg: 'bg-slate-800' }
    }
    if (type === 'container_created') {
      return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
    }
    if (type.includes('completed') || type.includes('success') || type.includes('approved')) {
      return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
    }
    if (type.includes('failed') || type.includes('error')) {
      return { icon: <XCircle className="w-5 h-5" />, color: 'text-red-400', bg: 'bg-red-900/20' }
    }
    if (type.includes('rejected')) {
      return { icon: <XCircle className="w-5 h-5" />, color: 'text-orange-400', bg: 'bg-orange-900/20' }
    }
    if (type === 'auction_best_bid') {
      try {
        const tail = Array.isArray(allEvents) ? allEvents.slice(Math.max(0, idx + 1)) : []
        const hasAuctionCompleted = tail.some(e => String(e?.type || '') === 'auction_completed')
        if (hasAuctionCompleted) {
          return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
        }
      } catch {
      }
      return { icon: <Clock className="w-5 h-5" />, color: 'text-slate-400', bg: 'bg-slate-800' }
    }
    if (type === 'task_attempt') {
      const outcome = taskAttemptOutcome(idx, data)
      if (outcome === 'completed') {
        return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
      }
      if (outcome === 'failed') {
        return { icon: <XCircle className="w-5 h-5" />, color: 'text-red-400', bg: 'bg-red-900/20' }
      }
      if (isMostRecentTaskAttempt) {
        return { icon: <Loader className="w-5 h-5 animate-spin" />, color: 'text-blue-400', bg: 'bg-blue-900/20' }
      }
      return { icon: <Clock className="w-5 h-5" />, color: 'text-slate-400', bg: 'bg-slate-800' }
    }
    if (type.includes('started')) {
      // Check if this phase has completed
      if (isPhaseCompleted(type)) {
        return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
      }
      if (isAuctionCompleted(type, idx)) {
        return { icon: <CheckCircle className="w-5 h-5" />, color: 'text-green-400', bg: 'bg-green-900/20' }
      }
      // In the Events log, avoid spinning indicators for historical "started" events.
      // Only the most recent event should ever look "active".
      if (isMostRecent) {
        return { icon: <Clock className="w-5 h-5" />, color: 'text-blue-400', bg: 'bg-blue-900/20' }
      }
      return { icon: <Clock className="w-5 h-5" />, color: 'text-blue-400', bg: 'bg-blue-900/20' }
    }
    return { icon: <Clock className="w-5 h-5" />, color: 'text-slate-400', bg: 'bg-slate-800' }
  }

  // Extract key information from event data
  const getEventSummary = (type, data) => {
    // Phase events
    if (type.includes('phase.')) {
      const phase = type.split('.')[1]
      const status = type.split('.')[2] || ''
      return `Phase: ${phase} ${status}`
    }

    // Approval events
    if (type === 'approval_requested') {
      const gate = data?.type || (data?.approval_id ? String(data.approval_id).split('_').pop() : 'unknown')
      return `Approval needed: ${gate}`
    }
    if (type === 'approval_updated') {
      const gate = data?.type || (data?.approval_id ? String(data.approval_id).split('_').pop() : 'unknown')
      return `Approval updated: ${gate}`
    }
    if (type === 'approval_given') {
      const isApproved = data.status === 'approved' || data.approved === true
      const approvalType = data.type || (data.approval_id ? String(data.approval_id).split('_').pop() : 'unknown')
      return `Approval ${isApproved ? 'approved' : 'rejected'}: ${approvalType}`
    }

    // Project events
    if (type === 'project_started') {
      return 'Project workflow started'
    }
    if (type === 'project_completed') {
      return 'Project completed successfully'
    }
    if (type === 'project_failed') {
      return `Project failed: ${data.error || 'Unknown error'}`
    }

    // Container events
    if (type === 'container_created') {
      const id = data.environment_id || data.container_id || data.env_id || data.id || data.name || 'ready'
      return `Container created: ${id}`
    }

    // Tool executed events
    if (type === 'tool_executed') {
      const toolName = data?.tool || data?.name || 'tool'
      return `Tool: ${toolName}`
    }

    // Streaming tool call events - show tool name
    if (type === 'agent.streaming.tool_call.start') {
      const toolName = data?.name || 'tool'
      return `Tool call: ${toolName}`
    }
    if (type === 'agent.streaming.tool_call.executing') {
      const toolName = data?.name || 'tool'
      return `Executing: ${toolName}`
    }
    if (type === 'agent.streaming.tool_call.result') {
      const toolName = data?.name || 'tool'
      const status = data?.status || 'done'
      return `Tool ${toolName}: ${status}`
    }
    if (type === 'agent.streaming.tool_call.error') {
      const toolName = data?.name || 'tool'
      const err = data?.error || data?.message || 'error'
      return `Tool ${toolName}: ${String(err).slice(0, 120)}`
    }
    if (type === 'agent.streaming.error') {
      const err = data?.error || data?.message || 'streaming error'
      const r = data?.round != null ? ` round ${data.round}` : ''
      return `Streaming error${r}: ${String(err).slice(0, 120)}`
    }

    // Delegation events (AppFactory-154) — surface the reviewer/critic verdict inline
    // so the auto-critic is visible at a glance (happy path included).
    if (type === 'agent.delegation.started') {
      const child = cleanAgentName(data?.child_agent)
      const r = data?.review
      return r?.verdict ? `Delegate → ${child} · critic(pre): ${r.verdict}` : `Delegate → ${child}`
    }
    if (type === 'agent.delegation.completed') {
      const child = cleanAgentName(data?.child_agent)
      const r = data?.review
      if (r?.verdict) {
        const dir = r.directive ? ` → ${r.directive}` : ''
        return `Delegation done: ${child} · critic: ${r.verdict}${dir}`
      }
      return `Delegation done: ${child}`
    }
    if (type === 'agent.delegation.failed') {
      const child = cleanAgentName(data?.child_agent)
      const reason = data?.error || ''
      return `Delegation rejected: ${child}${reason ? ' — ' + String(reason).slice(0, 100) : ''}`
    }

    // Context-compaction plugin (AppFactory-149/288). pre_send (proactive) and overflow
    // (reactive backstop) are both fold decisions — what folded, or why it skipped; the
    // other hooks are per-turn/-tool bookkeeping, labelled as one "Compaction" family.
    if (type === 'plugin.marker') {
      const hook = data?.hook
      const turnSuffix = Number.isInteger(data?.turn) ? ` · turn ${data.turn}` : ''
      if (hook === 'pre_send' || hook === 'overflow') {
        if (data?.compacted === true) {
          const folded = Number.isInteger(data?.middle_items) ? `, folded ${data.middle_items} items` : ''
          return `Context compacted: ${data?.before_tokens} tok → summary v${data?.version}${folded}${turnSuffix}`
        }
        const before = data?.before_tokens
        const thr = data?.threshold
        const budget = (before != null && thr != null) ? `: ${before}/${thr} tok` : (before != null ? `: ${before} tok` : '')
        return `Compaction skipped (${data?.skipped || 'no-op'})${budget}${turnSuffix}`
      }
      if (hook === 'post_turn') {
        const tot = data?.usage?.total_tokens
        return `Compaction · post-turn${Number.isInteger(data?.turn) ? ` ${data.turn}` : ''}${tot != null ? ` (${tot} tok)` : ''}`
      }
      if (hook === 'tool_result') return `Compaction · tool result${data?.tool ? ` (${data.tool})` : ''}`
      if (hook === 'pre_flight') return `Compaction · pre-flight${data?.tools_count != null ? ` (${data.tools_count} tools)` : ''}`
      if (hook === 'context_render') return `Compaction · context rendered${data?.rendered_chars != null ? ` (${data.rendered_chars} chars)` : ''}`
      return `Compaction · ${hook || 'marker'}`
    }

    // Default
    return type.replace(/_/g, ' ').replace(/\./g, ' → ')
  }

  // Check if event has error
  const hasError = (evt) => {
    const data = evt?.data || {}
    // A context_compaction marker's `error` is the overflow *trigger* that prompted a
    // recovery fold — a successful fold carries it too — so it's context, not a failure.
    // Real plugin failures arrive as a separate "plugin.error" event, never as a marker.
    if (evt?.type === 'plugin.marker') return false
    if (data?.error) return true
    if (data?.status === 'failed') return true
    try {
      if (typeof data?.exit_code === 'number' && data.exit_code !== 0) return true
    } catch {}
    return false
  }

  const status = getEventStatus(event, index)
  const summary = getEventSummary(event.type, event.data)
  const isError = hasError(event)

  return (
    <div className={`rounded-lg border ${isError ? 'border-red-700' : 'border-slate-700'} ${status.bg} overflow-hidden`}>
      {/* Compact Header */}
      <div 
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-slate-700/30 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Icon */}
        <div className={status.color}>
          {status.icon}
        </div>

        {/* Summary */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <EventPrimaryLine event={event} summary={summary} />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-slate-500">#{index + 1}</span>
            <span className="text-xs text-slate-500">•</span>
            <span className="text-xs text-slate-400">
              {event.timestamp?.toLocaleTimeString()}
            </span>
          </div>
        </div>

        {/* Expand button */}
        <button className="text-slate-400 hover:text-slate-300 flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-slate-700 bg-slate-900/50 p-4">
          <div className="mb-2">
            <span className="text-xs font-medium text-slate-400">Event Type:</span>
            <span className="text-xs text-slate-300 ml-2 font-mono">{event.type}</span>
          </div>
          
          {/* Show error prominently if present */}
          {isError && event.data?.error && (
            <div className="mb-3 p-3 bg-red-900/20 border border-red-700 rounded">
              <div className="text-xs font-medium text-red-400 mb-1">Error:</div>
              <div className="text-xs text-red-300 font-mono">{event.data.error}</div>
            </div>
          )}

          {/* Full data */}
          <div className="text-xs font-medium text-slate-400 mb-1">Full Data:</div>
          <pre className="text-xs text-slate-400 overflow-auto max-h-64 bg-slate-950 p-3 rounded">
            {JSON.stringify(event.data, null, 2)}
          </pre>

          {/* Optional quick action: revert to previous user action */}
          {typeof onRevertToLastUserAction === 'function' && (
            <div className="mt-3">
              <button
                onClick={(e) => { e.stopPropagation(); onRevertToLastUserAction() }}
                className="bg-yellow-700 hover:bg-yellow-600 text-white text-xs px-3 py-1.5 rounded"
              >
                Revert to previous user action
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
