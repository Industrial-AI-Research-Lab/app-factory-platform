import { CheckCircle, XCircle, AlertTriangle, Clock, Loader, Brain, Wrench } from 'lucide-react'

export const findTaskName = (id, project) => {
  try {
    if (!id) return 'unknown task'
    const list = project?.plan?.tasks || []
    const t = list.find(x => x.task_id === id)
    return (t?.description || t?.name || id)
  } catch {
    return id || 'task'
  }
}

export const taskTitle = (d, project) => {
  const map = {
    gather_requirements: 'Gather project requirements from user',
    answer_questions: 'Answer requirements questions automatically',
    create_plan: 'Create hierarchical task breakdown',
    coding: 'Implement task',
    qa: 'Validate implementation',
    testing: 'Run tests',
  }
  return d?.task_description || findTaskName(d?.task_id, project) || map[d?.task_type] || 'Task'
}

export const summarizeEvent = (evt, project) => {
  const type = evt?.type || ''
  const d = evt?.data || {}
  if (type === 'project_started') return 'Project started'
  if (type === 'container_created') return d.environment_id ? `Container ready: ${d.environment_id}` : 'Container prepared'
  if (type === 'task_attempt') {
    const name = taskTitle(d, project)
    const a = d.attempt ? ` attempt ${d.attempt}` : ''
    const who = d.agent_display_name || d.agent_id
    const ag = who ? ` by ${who}` : ''
    return `Task: ${name}${a}${ag}`
  }
  if (type === 'task_completed') {
    const name = taskTitle(d, project)
    const who = d.agent_display_name || d.agent_id
    const ag = who ? ` by ${who}` : ''
    return `Task completed: ${name}${ag}`
  }
  if (type === 'task_failed') {
    const name = taskTitle(d, project)
    const err = d.error ? ` – ${String(d.error).slice(0, 80)}` : ''
    return `Task failed: ${name}${err}`
  }
  if (type === 'tool_executed') {
    const tool = d.tool_id || 'tool'
    const p = d.params || {}
    const primary = p.path || p.file_path || p.command || p.pattern || p.Url || p.url || ''
    const short = typeof primary === 'string' ? primary.slice(0, 60) : ''
    return short ? `Tool: ${tool} (${short})` : `Tool: ${tool}`
  }
  if (type === 'auction_started') {
    return 'Collecting bids…'
  }
  if (type === 'auction_completed') {
    const name = findTaskName(d.task_id, project)
    const base = d.winner_display_name || d.winner_id || 'agent'
    const agent = d.winner_type ? `${base} (${d.winner_type})` : base
    const conf = typeof d.confidence === 'number' ? ` [${Math.round(d.confidence * 100)}%]` : ''
    return `Auction: ${name} → ${agent}${conf}`
  }
  if (type === 'auction_bid_started') {
    const name = d.task_description || findTaskName(d.task_id, project)
    const who = d.agent_display_name || d.agent_id || 'agent'
    return `Bid started: ${who} on ${name}`
  }
  if (type === 'auction_bid_completed') {
    const name = d.task_description || findTaskName(d.task_id, project)
    const who = d.agent_display_name || d.agent_id || 'agent'
    const conf = typeof d.confidence === 'number' ? ` [${Math.round(d.confidence * 100)}%]` : ''
    return `Bid completed: ${who} on ${name}${conf}`
  }
  if (type === 'auction_bid_timeout') {
    const name = d.task_description || findTaskName(d.task_id, project)
    const who = d.agent_display_name || d.agent_id || 'agent'
    return `Bid timeout: ${who} on ${name}`
  }
  if (type === 'auction_bid_failed') {
    const name = d.task_description || findTaskName(d.task_id, project)
    const who = d.agent_display_name || d.agent_id || 'agent'
    const err = d.error ? ` – ${String(d.error).slice(0, 80)}` : ''
    return `Bid failed: ${who} on ${name}${err}`
  }
  if (type === 'auction_best_bid') {
    const agent = d.agent_display_name || d.agent_id || 'agent'
    const conf = typeof d.confidence === 'number' ? ` [${Math.round(d.confidence * 100)}%]` : ''
    return `Best bid: ${agent}${conf}`
  }
  // Phase boundary events. Driven generically off the type string so any
  // phase declared in workflows.json gets a label without a code change here
  // (see auto-memory feedback_no_hardcoded_phase_names). The handler was
  // present in the original implementation (f07a62f, ChatInterface.jsx:339-340),
  // deleted as collateral in 9859d60 ("Updated icons for events"), and never
  // restored — leaving phase events to render through the generic slugifier
  // at the bottom of this function as e.g. "phase → planning → started".
  if (type.startsWith('phase.') && (type.endsWith('.started') || type.endsWith('.completed'))) {
    const segs = type.split('.')
    const phaseName = segs[1] || ''
    const status = segs[segs.length - 1]
    const pretty = phaseName ? `${phaseName.charAt(0).toUpperCase()}${phaseName.slice(1)}` : 'Phase'
    return `${pretty} phase ${status}`
  }
  // Streaming events for thinking models
  if (type === 'agent.streaming.thinking.delta' || type === 'agent.streaming.thinking.done') {
    const time = d.thinking_time ? `${Math.round(d.thinking_time)}s` : ''
    return time ? `Thought for ${time}` : 'Thinking...'
  }
  if (type === 'agent.streaming.tool_call.start') {
    const tool = d.name || d.tool_name || d.tool || d.tool_id || 'tool'
    const args = d.arguments || d.params || {}
    const primary = args.path || args.file_path || args.command || args.pattern || args.Url || args.url || ''
    const short = typeof primary === 'string' ? primary.slice(0, 60) : ''
    return short ? `Calling ${tool} (${short})...` : `Calling ${tool}...`
  }
  if (type === 'agent.streaming.tool_call.executing') {
    const tool = d.name || d.tool_name || d.tool || d.tool_id || 'tool'
    const args = d.arguments || d.params || {}
    const primary = args.path || args.file_path || args.command || args.pattern || args.Url || args.url || ''
    const short = typeof primary === 'string' ? primary.slice(0, 60) : ''
    return short ? `Executing ${tool} (${short})...` : `Executing ${tool}...`
  }
  if (type === 'agent.streaming.tool_call.result') {
    const tool = d.name || d.tool_name || d.tool || d.tool_id || 'tool'
    const status = d.status === 'error' ? 'failed' : 'completed'
    return `Tool ${tool} ${status}`
  }
  if (type === 'agent.streaming.tool_call.error') {
    const tool = d.name || d.tool_name || d.tool || d.tool_id || 'tool'
    const err = d.error || d.message || 'error'
    return `Tool ${tool}: ${String(err).slice(0, 120)}`
  }
  if (type === 'agent.streaming.error') {
    const err = d.error || d.message || 'streaming error'
    const r = d.round != null ? ` (round ${d.round})` : ''
    return `Streaming error${r}: ${String(err).slice(0, 120)}`
  }
  if (type === 'agent.streaming.round.retry') {
    const attempt = d.attempt != null ? Number(d.attempt) : null
    const maxAttempts = d.max_attempts != null ? Number(d.max_attempts) : null
    const n =
      attempt != null && maxAttempts != null
        ? `${attempt}/${maxAttempts}`
        : attempt != null
          ? String(attempt)
          : null
    const backoff =
      typeof d.backoff_seconds === 'number' ? ` (~${d.backoff_seconds}s)` : ''
    return n
      ? `Provider retry ${n}${backoff}`
      : `Provider retry${backoff}`
  }
  // text.delta / text.done are not handled here — they're not currentItem
  // candidates in LiveActivity (see the long comment at LiveActivity.jsx
  // ~line 346 explaining why text.done lingering as a bottom-line status
  // misleads the user). The per-agent agentsWriting panel covers the live
  // streaming view; this function is only reached for events the status line
  // should explain, and text transitions don't belong there.
  // Without explicit handlers below, approval events fell through to the
  // generic `type.replace(_, ' ')` and rendered as plain "approval
  // requested" — which on project 1bcaff3b confused the user, who had just
  // approved gate e77525ad ("Review requirements") and saw a NEW gate
  // 777054ce ("Review plan") shown with the same generic label. The
  // approval payload carries `gate_type` (e.g. "Review plan", "Review
  // requirements"); surface it so each gate is distinguishable.
  if (type === 'approval_requested') {
    const gate = d.gate_type || d.approval_type || d.type || 'review'
    return `Awaiting approval: ${gate}`
  }
  if (type === 'approval_given') {
    const gate = d.gate_type || d.approval_type || d.type || 'review'
    const decision = (d.status || d.decision || 'approved').toString()
    const cap = decision.charAt(0).toUpperCase() + decision.slice(1)
    return `${cap}: ${gate}`
  }
  if (type === 'approval_updated') {
    // approval_updated == "approval content refreshed, user still needs to
    // act" — render as a fresh wait state, not as a transition. The previous
    // "Approval updated: …" label read like a completed event and looked out
    // of place in the bottom status strip.
    const gate = d.gate_type || d.approval_type || d.type || 'review'
    return `Awaiting approval: ${gate}`
  }
  if (type === 'intent_routing_started') {
    // Emitted by messages.py around the synchronous intent-classifier LLM
    // call. The gate name (when present) lets the user tell at a glance which
    // open approval their feedback is being routed to.
    const gate = d.pending_approval_type
    return gate ? `Processing your feedback on: ${gate}` : 'Processing your message…'
  }
  return type.replace(/_/g, ' ').replace(/\./g, ' → ')
}

export const iconForEvent = (evt) => {
  const t = evt?.type || ''
  if (t === 'project_started') return <CheckCircle className="w-4 h-4 text-green-400" />
  if (t === 'approval_requested') return <Clock className="w-4 h-4 text-amber-400" />
  if (t === 'approval_updated') return <AlertTriangle className="w-4 h-4 text-amber-400" />
  if (t === 'approval_given') return <CheckCircle className="w-4 h-4 text-green-400" />
  if (t === 'container_created') return <CheckCircle className="w-4 h-4 text-green-400" />
  if (t === 'auction_rejected') return <XCircle className="w-4 h-4 text-slate-400" />
  if (t === 'auction_best_bid') return <Clock className="w-4 h-4 text-slate-400" />
  if (t === 'task_attempt') return <Loader className="w-4 h-4 text-blue-400 animate-spin" />
  if (t === 'task_completed') return <CheckCircle className="w-4 h-4 text-green-400" />
  if (t === 'task_failed') return <XCircle className="w-4 h-4 text-red-400" />
  if (t === 'tool_executed') return <CheckCircle className="w-4 h-4 text-green-400" />
  if (t === 'intent_routing_started') return <Loader className="w-4 h-4 text-blue-400 animate-spin" />
  if (t.endsWith('.started')) return <Clock className="w-4 h-4 text-blue-400" />
  if (t === 'auction_started' || t === 'auction_bid_started') return <Clock className="w-4 h-4 text-blue-400" />
  // Streaming events for thinking models
  if (t.includes('thinking')) return <Brain className="w-4 h-4 text-purple-400" />
  if (t.includes('tool_call')) return <Wrench className="w-4 h-4 text-blue-400" />
  if (t.includes('text.delta') || t.includes('text.done')) return <Loader className="w-4 h-4 text-green-400 animate-spin" />
  if (t.includes('failed') || t.includes('error')) return <XCircle className="w-4 h-4 text-red-400" />
  if (t.includes('completed') || t.includes('approved')) return <CheckCircle className="w-4 h-4 text-green-400" />
  return <Clock className="w-4 h-4 text-slate-400" />
}

export const labelClassForEvent = (evt) => {
  const t = evt?.type || ''
  if (t === 'approval_requested') return 'text-amber-200'
  if (t === 'task_attempt') return 'text-blue-200'
  if (t.endsWith('.started') || t.endsWith('_started') || t === 'auction_started' || t === 'auction_bid_started') return 'text-blue-200'
  // Streaming events for thinking models
  if (t.includes('thinking')) return 'text-purple-200'
  if (t.includes('tool_call')) return 'text-blue-200'
  if (t.includes('text.delta') || t.includes('text.done')) return 'text-green-200'
  if (t === 'task_completed' || t === 'approval_given' || t.includes('completed') || t.includes('approved')) return 'text-green-200'
  if (t === 'task_failed' || t.includes('failed') || t.includes('error')) return 'text-red-200'
  if (t === 'auction_rejected' || t === 'auction_best_bid') return 'text-slate-300'
  return 'text-slate-200'
}

export const condenseRecentEvents = (recentEvents) => {
  if (!recentEvents || recentEvents.length === 0) return []
  const latest = new Map()
  const prio = (t) => t === 'approval_given' ? 3 : (t === 'approval_updated' ? 2 : (t === 'approval_requested' ? 1 : 0))
  for (let i = recentEvents.length - 1; i >= 0; i -= 1) {
    const e = recentEvents[i]
    const t = e?.type || ''
    let key = t
    if (t === 'approval_requested' || t === 'approval_updated' || t === 'approval_given') {
      const d = e?.data || {}
      const gate = d.approval_id ? String(d.approval_id).split('_').pop() : (d.type || d.approval_type || '')
      key = `approval:${gate || 'unknown'}`
    }
    if (t.startsWith('phase.')) {
      const segs = t.split('.')
      key = `${segs[0]}.${segs[1]}`
    }
    if (!latest.has(key)) {
      latest.set(key, e)
    } else {
      const existing = latest.get(key)
      const existingType = existing?.type || ''
      if (t.startsWith('phase.') && t.endsWith('.completed') && existingType.endsWith('.started')) {
        latest.set(key, e)
      }
      if ((t === 'approval_requested' || t === 'approval_updated' || t === 'approval_given')) {
        if (prio(t) > prio(existingType)) {
          latest.set(key, e)
        }
      }
    }
    if (latest.size >= 12) break
  }
  return Array.from(latest.values()).slice(0, 5)
}

// approval_updated is treated as a wait state alongside approval_requested:
// the BE emits approval_updated when an approval's content is REFRESHED
// (e.g. planner refined the plan after user feedback) — the gate is still
// pending, the user still needs to act. Without including it here, phase 1
// of currentItem couldn't return the latest approval state when the gate
// content was refined, so after a re-plan the bottom strip fell through to
// stale task_attempt / phase.X.started events instead of saying "Awaiting
// approval" with a fresh timer — verified on project 2bbc159e where the
// strip read "Task: Re-plan based on user feedback attempt 1 [52s]" even
// though approval_updated had fired 39s prior and the revised plan was
// already visible above.
export const isApprovalWait = (e) => {
  const t = e?.type
  return t === 'approval_requested' || t === 'approval_updated'
}
export const isCompleted = (e) => ((e?.type || '').includes('completed') || (e?.type === 'approval_given'))
export const isInProgress = (e) => {
  const t = e?.type || ''
  if (isApprovalWait(e)) return false
  if (t === 'task_attempt') return true
  if (t.endsWith('.started') || t.endsWith('_started')) return true
  if (t === 'auction_started' || t === 'auction_bid_started') return true
  return false
}
