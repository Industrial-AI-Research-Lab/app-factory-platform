const TERMINAL = new Set(['completed', 'failed'])
const TERMINAL_PROJECT_STATUSES = new Set(['failed', 'cancelled'])
const TERMINAL_LIFECYCLE_EVENTS = new Set(['project_failed', 'project_cancelled', 'project_stopped'])
const LIFECYCLE_RESET_EVENTS = new Set(['project_started', 'project_reverted'])

function isTerminal(status) {
  return TERMINAL.has(status)
}

/** Order-aware: only the latest lifecycle signal counts (revert/resume after stop). */
function projectLifecycleIsTerminal(events = []) {
  let terminal = false
  for (const evt of events) {
    const type = evt?.type
    if (!type) continue
    if (TERMINAL_LIFECYCLE_EVENTS.has(type)) {
      terminal = true
    } else if (LIFECYCLE_RESET_EVENTS.has(type) || type.endsWith('.started')) {
      terminal = false
    }
  }
  return terminal
}

function isTerminalProject(projectStatus, events = []) {
  if (TERMINAL_PROJECT_STATUSES.has((projectStatus || '').toLowerCase())) return true
  return projectLifecycleIsTerminal(events)
}

export function planTaskIds(planTasks = []) {
  return (planTasks || []).map((t, idx) => t?.task_id || `task_${idx + 1}`)
}

export function buildPlanTaskStatuses(planTasks = [], events = [], { projectStatus } = {}) {
  const byId = new Map()
  ;(planTasks || []).forEach((t, idx) => {
    const id = t.task_id || `task_${idx + 1}`
    byId.set(id, {
      id,
      description: t.description || t.name || `Task ${idx + 1}`,
      type: t.type || 'task',
      order: idx,
      status: 'pending',
      agent_id: null,
      agent_type: null,
      attempts: 0,
    })
  })

  for (const evt of events) {
    const { type, data } = evt || {}
    if (!data?.task_id) continue
    const entry = byId.get(data.task_id)
    if (!entry) continue

    if (type === 'auction_completed') {
      if (!isTerminal(entry.status)) entry.status = 'claimed'
      entry.agent_id = data.winner_id || data.agent_id || entry.agent_id
      entry.agent_type = data.winner_type || entry.agent_type
      entry.agent_display_name = data.winner_display_name || entry.agent_display_name
    } else if (type === 'task_attempt') {
      if (!isTerminal(entry.status)) entry.status = 'in_progress'
      entry.agent_id = data.agent_id || entry.agent_id
      entry.agent_display_name = data.agent_display_name || entry.agent_display_name
      entry.attempts = Math.max(entry.attempts || 0, data.attempt || 1)
    } else if (type === 'task_completed') {
      entry.status = 'completed'
      entry.agent_id = data.agent_id || entry.agent_id
      entry.agent_display_name = data.agent_display_name || entry.agent_display_name
    } else if (type === 'task_failed') {
      if (data.reason === 'cancelled') {
        if (!isTerminal(entry.status)) entry.status = 'skipped'
      } else {
        entry.status = 'failed'
      }
      entry.agent_id = data.agent_id || entry.agent_id
      entry.agent_display_name = data.agent_display_name || entry.agent_display_name
    } else if (type === 'execution_task_finished') {
      const st = (data.status || '').toLowerCase()
      if (st === 'completed' && !isTerminal(entry.status)) entry.status = 'completed'
      else if (st === 'failed' && !isTerminal(entry.status)) entry.status = 'failed'
    }
  }

  const rows = Array.from(byId.values()).sort((a, b) => a.order - b.order)
  if (isTerminalProject(projectStatus, events)) {
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'claimed' || row.status === 'in_progress') {
        row.status = 'skipped'
      }
    }
  }
  return rows
}

export function planTasksBadge(planTasks = [], events = [], { projectStatus } = {}) {
  const ids = planTaskIds(planTasks)
  if (!ids.length) return null
  const rows = buildPlanTaskStatuses(planTasks, events, { projectStatus })
  const completed = rows.filter((r) => r.status === 'completed').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const base = `${completed}/${ids.length}`
  if (failed > 0) return `${base} (${failed} failed)`
  return base
}
