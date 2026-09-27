/**
 * SystemMessage Component
 * 
 * Renders system notifications (phase changes, approval results, errors).
 */

import { Info, CheckCircle, XCircle, AlertTriangle, Play, CheckCheck } from 'lucide-react'

const SUBTYPE_CONFIG = {
  phase_started: {
    icon: Play,
    bgClass: 'bg-blue-900/20 border-blue-700/30',
    iconClass: 'text-blue-400',
    textClass: 'text-blue-300'
  },
  phase_completed: {
    icon: CheckCheck,
    bgClass: 'bg-green-900/20 border-green-700/30',
    iconClass: 'text-green-400',
    textClass: 'text-green-300'
  },
  approval_result: {
    icon: CheckCircle,
    bgClass: 'bg-emerald-900/20 border-emerald-700/30',
    iconClass: 'text-emerald-400',
    textClass: 'text-emerald-300'
  },
  error: {
    icon: AlertTriangle,
    bgClass: 'bg-red-900/20 border-red-700/30',
    iconClass: 'text-red-400',
    textClass: 'text-red-300'
  },
  param_degraded: {
    icon: AlertTriangle,
    bgClass: 'bg-amber-900/20 border-amber-700/30',
    iconClass: 'text-amber-400',
    textClass: 'text-amber-300'
  },
  default: {
    icon: Info,
    bgClass: 'bg-slate-800/50 border-slate-700/30',
    iconClass: 'text-slate-400',
    textClass: 'text-slate-300'
  }
}

export default function SystemMessage({ message }) {
  const config = SUBTYPE_CONFIG[message.subtype] || SUBTYPE_CONFIG.default
  const Icon = config.icon

  const timestamp = message.created_at
    ? new Date(message.created_at).toLocaleTimeString()
    : null

  const data = message.data
  const detailText = data == null
    ? null
    : typeof data === 'string'
      ? data
      : (data.detail || data.error || JSON.stringify(data, null, 2))
  const detailMeta = data && typeof data === 'object'
    ? [data.error_type, data.node_id].filter(Boolean).join(' · ')
    : null

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${config.bgClass}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${config.iconClass}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm ${config.textClass}`}>
            {message.content}
          </span>
          {timestamp && (
            <span className="text-xs text-slate-500">{timestamp}</span>
          )}
        </div>
        {message.subtype === 'error' && detailText && (
          <details className="mt-2">
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-400">
              Details
            </summary>
            {detailMeta && (
              <div className="mt-1 text-xs text-slate-500">{detailMeta}</div>
            )}
            <pre className="mt-1 text-xs text-red-300 bg-red-950/50 p-2 rounded overflow-auto max-h-32 whitespace-pre-wrap break-words">
              {detailText}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}
