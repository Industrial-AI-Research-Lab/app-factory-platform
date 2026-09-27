import { cleanAgentName, isFailureEvent } from '../utils/eventFacets'
import EventModelCog from './EventModelCog'

const AgentChip = ({ children }) => (
  <span className="text-xs font-semibold text-slate-200 bg-slate-700 border border-slate-600 rounded px-2 py-0.5">{children}</span>
)
const ToolChip = ({ children }) => (
  <span className="font-mono text-xs text-blue-100 bg-blue-500/15 border border-blue-500/30 rounded px-2 py-0.5">{children}</span>
)
const ResultBadge = ({ error, children }) => (
  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded px-2 py-0.5 ${error ? 'text-red-300 bg-red-500/15' : 'text-emerald-300 bg-emerald-500/15'}`}>{children}</span>
)

function agentLabelOf(event) {
  const d = event?.data || {}
  return event._agentLabel
    || d.agent_display_name
    || (d.agent_id ? cleanAgentName(d.agent_id) : (d.parent_agent ? cleanAgentName(d.parent_agent) : ''))
}

/**
 * A row leads with identity — who did what to which tool, and the outcome —
 * instead of the mechanical event type. Only generic, cross-tool
 * result fields are surfaced (status, a delegate target, a filename, a count);
 * per-tool result shapes stay in the raw expand and are never parsed here. Event
 * types with no agent/tool identity fall back to the passed `summary` text.
 * `event._agentLabel` is the run-consistent label from annotateEvents when
 * present; otherwise it is derived locally so this works for any caller.
 */
export default function EventPrimaryLine({ event, summary }) {
  const t = event?.type || ''
  const d = event?.data || {}
  const agentLabel = agentLabelOf(event)
  const agent = agentLabel ? <AgentChip>{agentLabel}</AgentChip> : null
  const fallback = <span className="text-sm font-medium text-slate-200 truncate">{summary}</span>

  if (t === 'agent.streaming.tool_call.result' || t === 'tool_executed') {
    const tool = d.name || d.tool || d.tool_id || 'tool'
    const r = d.result || {}
    const error = isFailureEvent(t, d)
    let detail = error ? 'error' : 'success'
    if (!error) {
      if (r.agent_id) detail = `→ ${cleanAgentName(r.agent_id)}`
      else if (r.filename) detail = String(r.filename)
      else if (typeof r.count === 'number') detail = `${r.count} items`
    }
    return (
      <span className="flex items-center gap-2 flex-wrap min-w-0">
        {agent}<span className="text-sm text-slate-400">called</span><ToolChip>{tool}</ToolChip>
        <ResultBadge error={error}>{detail}</ResultBadge>
        <EventModelCog event={event} />
      </span>
    )
  }
  if (t === 'task_attempt') {
    return (
      <span className="flex items-center gap-2 flex-wrap min-w-0">
        {agent}<span className="text-sm text-slate-400">started</span>
        <span className="text-sm text-slate-200 font-medium truncate">{d.task_description || d.task_type || 'task'}</span>
        <EventModelCog event={event} />
      </span>
    )
  }
  if (t === 'agent.streaming.text.done') {
    return (
      <span className="flex items-center gap-2 flex-wrap min-w-0">
        {agent}<span className="text-sm text-slate-400">produced output</span>
        <span className="text-[11px] text-blue-300 bg-blue-500/15 rounded px-2 py-0.5">{(d.content || '').length} chars</span>
        <EventModelCog event={event} />
      </span>
    )
  }
  if (t.startsWith('agent.delegation')) {
    const verb = t.endsWith('.started') ? 'delegated to' : t.endsWith('.failed') ? 'delegation rejected' : 'returned from'
    const other = d.child_agent || d.parent_agent
    const otherLabel = other ? cleanAgentName(other) : ''
    return (
      <span className="flex items-center gap-2 flex-wrap min-w-0">
        {agent}<span className="text-sm text-slate-400">{verb}</span>
        {otherLabel && <AgentChip>{otherLabel}</AgentChip>}
        <EventModelCog event={event} />
      </span>
    )
  }
  return fallback
}
