/**
 * EventMessage Component
 * 
 * Renders lightweight event messages (task progress, tool execution).
 * These are typically collapsed or shown with less prominence.
 */

import { Activity, Wrench, FileCode, Terminal } from 'lucide-react'
import { useState } from 'react'

const SUBTYPE_ICONS = {
  task_started: Activity,
  task_completed: Activity,
  tool_execution: Wrench,
  file_created: FileCode,
  file_modified: FileCode,
  command_executed: Terminal,
  default: Activity
}

export default function EventMessage({ message }) {
  const [expanded, setExpanded] = useState(false)
  
  const Icon = SUBTYPE_ICONS[message.subtype] || SUBTYPE_ICONS.default
  
  const timestamp = message.created_at 
    ? new Date(message.created_at).toLocaleTimeString() 
    : null

  // Events are shown in a more compact format
  return (
    <div 
      className="flex items-center gap-2 py-1 px-2 text-xs text-slate-500 hover:text-slate-400 cursor-pointer transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <Icon className="w-3 h-3 flex-shrink-0" />
      <span className="truncate flex-1">{message.content}</span>
      {timestamp && (
        <span className="flex-shrink-0">{timestamp}</span>
      )}
      
      {expanded && message.data && (
        <div 
          className="absolute mt-8 left-0 right-0 mx-4 p-2 bg-slate-900 border border-slate-700 rounded shadow-lg z-10"
          onClick={e => e.stopPropagation()}
        >
          <pre className="text-xs text-slate-300 overflow-auto max-h-48">
            {JSON.stringify(message.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
