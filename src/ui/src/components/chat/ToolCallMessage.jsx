/**
 * ToolCallMessage Component
 *
 * Renders one tool journal action: a tool_call paired with its tool_result
 * (matched upstream by buildToolJournalIndex), a hanging call ("awaiting
 * result" — the point where the agent stopped), or an orphan result whose
 * call fell outside the fetched window.
 */

import { Wrench, CheckCircle, XCircle, Clock } from 'lucide-react'
import { toolCallState } from './toolJournalUtils'

const STATE_CONFIG = {
  ok: {
    icon: CheckCircle,
    label: 'ok',
    iconClass: 'text-green-400',
    badgeClass: 'text-green-300 bg-green-900/30',
  },
  error: {
    icon: XCircle,
    label: 'error',
    iconClass: 'text-red-400',
    badgeClass: 'text-red-300 bg-red-900/30',
  },
  awaiting: {
    icon: Clock,
    label: 'awaiting result',
    iconClass: 'text-amber-400 animate-pulse',
    badgeClass: 'text-amber-300 bg-amber-900/30',
  },
}

function prettyPayload(value) {
  if (value == null) return null
  if (typeof value !== 'string') return JSON.stringify(value, null, 2)
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export default function ToolCallMessage({ call, result }) {
  const anchor = call || result
  if (!anchor) return null

  const name = call?.data?.name || result?.data?.name || 'unknown tool'
  const state = toolCallState(result)
  const config = STATE_CONFIG[state]
  const StateIcon = config.icon

  const timestamp = anchor.created_at
    ? new Date(anchor.created_at).toLocaleTimeString()
    : null

  const args = prettyPayload(call?.data?.arguments)
  const resultPreview = prettyPayload(result?.data?.result)
  const hasDetails = Boolean(args || resultPreview)

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border bg-slate-800/50 border-slate-700/30">
      <Wrench className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-400" />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-300 font-mono break-all">{name}</span>
          <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${config.badgeClass}`}>
            <StateIcon className={`w-3 h-3 ${config.iconClass}`} />
            {config.label}
          </span>
          {!call && (
            <span className="text-xs text-slate-500">result for an earlier call</span>
          )}
          {timestamp && <span className="text-xs text-slate-500">{timestamp}</span>}
        </div>
        {hasDetails && (
          <details className="mt-2">
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-400">
              Details
            </summary>
            {args && (
              <pre className="mt-1 text-xs text-slate-300 bg-slate-900/60 p-2 rounded overflow-auto max-h-40 whitespace-pre-wrap break-all">
                {args}
              </pre>
            )}
            {resultPreview && (
              <pre className="mt-1 text-xs text-slate-400 bg-slate-900/60 p-2 rounded overflow-auto max-h-40 whitespace-pre-wrap break-all">
                {resultPreview}
              </pre>
            )}
          </details>
        )}
      </div>
    </div>
  )
}
