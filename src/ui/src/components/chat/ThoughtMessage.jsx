/**
 * ThoughtMessage Component
 * 
 * Displays a completed thought block in the chat UI.
 * Expandable to show full thinking content.
 */
import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Gavel, Clock, Coins, Search } from 'lucide-react'
import AgentInvocationInspector from '../AgentInvocationInspector'

function formatAgentName(agentId) {
  if (!agentId) return null
  // Convert agent_id like "requirements_gatherer_001@abc123" to "Requirements Gatherer"
  const base = agentId.split('@')[0].replace(/_\d+$/, '')
  return base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function formatTime(date) {
  if (!date) return null
  const d = date instanceof Date ? date : new Date(date)
  if (isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatUsage(usage) {
  if (!usage) return null
  const tokens = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
  if (!tokens) return null
  const cost = usage.cost
  if (cost !== undefined && cost !== null) {
    return `${tokens.toLocaleString()} tokens ($${cost.toFixed(4)})`
  }
  return `${tokens.toLocaleString()} tokens`
}

export default function ThoughtMessage({ message }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const capture = message._capture || null

  const rawTime = message.thinkingTime || message.data?.thinking_time || 0
  const thinkingTime = typeof rawTime === 'number' ? rawTime.toFixed(1) : rawTime
  const content = message.content || message.data?.content || ''
  const round = message.round || message.data?.round || 1
  const agentId = message.agentId || message.data?.agent_id || null
  const agentName = formatAgentName(agentId)
  const phase = message.phase || message.data?.phase || null
  const usage = message.usage || message.data?.usage || null
  const finishedAt = message.finishedAt || message.data?.finished_at || null
  // Only present for non-natural finishes — "auction timed out" / "cancelled" / "error".
  // Stamped onto the thought by ChatInterface.extractCompletedThoughts when a
  // matching agent.validation.timeout / agent.streaming.terminated event was
  // observed within the time window.
  const finishReason = message.finishReason || null

  // Buffered = provider sent the full response in one SSE chunk after a real
  // wire delay. thinking_time collapses to ~0 in that case, so we display
  // wireElapsedMs (backend STREAM.start→end interval) instead — the only
  // honest "how long did the model actually work" measure we have.
  const buffered = !!message.buffered
  const wireElapsedMs = typeof message.wireElapsedMs === 'number' ? message.wireElapsedMs : null
  const wireElapsedS = wireElapsedMs != null ? (wireElapsedMs / 1000).toFixed(1) : null

  const isBidding = phase === 'bidding' || phase === 'auction'

  const timeLabel = (() => {
    const parts = []
    if (agentName) parts.push(agentName)
    if (buffered && wireElapsedS) {
      parts.push(`thought for [${wireElapsedS}s]`)
    } else if (rawTime > 0) {
      parts.push(`thought for [${thinkingTime}s]`)
    } else {
      parts.push('thought')
    }
    return parts.join(' ')
  })()
  
  const finishedTimeStr = formatTime(finishedAt)
  const usageStr = formatUsage(usage)
  
  // Different styling for bidding vs actual work
  const containerClass = isBidding
    ? "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/50 border border-slate-600/50 cursor-pointer hover:bg-slate-700/50 transition-colors"
    : "inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-900/30 border border-purple-700/50 cursor-pointer hover:bg-purple-900/40 transition-colors"
  
  const textClass = isBidding ? "text-xs text-slate-400" : "text-sm font-medium text-purple-200"
  const iconClass = isBidding ? "text-slate-500" : "text-purple-400"
  const IconComponent = isBidding ? Gavel : Brain
  
  return (
    <div className={`flex gap-4 ${isBidding ? 'my-1' : 'my-3'}`}>
      <div className={`flex-shrink-0 w-10 h-10 rounded-full ${isBidding ? 'bg-slate-800/50' : 'bg-purple-900/50'} flex items-center justify-center`}>
        <IconComponent className={`w-5 h-5 ${iconClass}`} />
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div 
            className={containerClass}
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isBidding && <span className="text-xs text-slate-500">[bid]</span>}
            <span className={textClass}>
              {timeLabel}
            </span>
            {round > 1 && (
              <span className="text-xs text-slate-500">
                (round {round})
              </span>
            )}
            {finishReason && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded border ${
                  finishReason === 'error'
                    ? 'text-red-300 border-red-500/40 bg-red-900/20'
                    : 'text-amber-300 border-amber-500/40 bg-amber-900/20'
                }`}
                title={`Stream did not complete naturally: ${finishReason}`}
              >
                {finishReason}
              </span>
            )}
            {buffered && !finishReason && (
              <span
                className="text-xs px-1.5 py-0.5 rounded border text-amber-300/80 border-amber-500/30 bg-amber-900/10"
                title={`Provider sent the full response in one SSE chunk (wire elapsed ${wireElapsedS}s). Real token-by-token streaming wasn't available on this endpoint.`}
              >
                buffered
              </span>
            )}
            <button className={`${iconClass} hover:opacity-80 ml-1`}>
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          </div>
          {capture?.callId && (
            <button
              onClick={(e) => { e.stopPropagation(); setInspectorOpen(true) }}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-600/60 text-slate-300 hover:bg-slate-700/50 hover:text-slate-100"
              title="Open Inspector: see effective prompt, tools, and raw response"
            >
              <Search className="w-3 h-3" /> Inspector
            </button>
          )}
          
          {/* Metadata: timestamp, usage */}
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {finishedTimeStr && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {finishedTimeStr}
              </span>
            )}
            {usageStr && (
              <span className="flex items-center gap-1">
                <Coins className="w-3 h-3" />
                {usageStr}
              </span>
            )}
          </div>
        </div>
        
        {isExpanded && content && (
          <div className={`mt-2 p-4 rounded-lg ${isBidding ? 'bg-slate-900/50 border-slate-700/30' : 'bg-slate-900/80 border-purple-700/30'} border`}>
            <div className="text-sm text-slate-300 whitespace-pre-wrap font-mono max-h-96 overflow-y-auto">
              {content}
            </div>
          </div>
        )}
      </div>
      {inspectorOpen && capture?.callId && (
        <AgentInvocationInspector callId={capture.callId} onClose={() => setInspectorOpen(false)} />
      )}
    </div>
  )
}
