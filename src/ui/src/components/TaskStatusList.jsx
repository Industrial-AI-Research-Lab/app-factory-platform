import { useMemo, useState } from 'react'
import { CheckCircle, XCircle, Loader, Clock, User, FileDiff, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { apiFetch } from '../utils_api'
import { buildPlanTaskStatuses } from '../utils/planTaskStatusUtils'

export default function TaskStatusList({ project, projectId, events = [] }) {
  const tasks = useMemo(
    () => buildPlanTaskStatuses(project?.plan?.tasks || [], events, { projectStatus: project?.status }),
    [project?.plan?.tasks, project?.status, events],
  )

  const [expanded, setExpanded] = useState(() => new Set())
  const [diffs, setDiffs] = useState({})
  const [loading, setLoading] = useState({})

  const toggle = async (id) => {
    const next = new Set(expanded)
    if (next.has(id)) {
      next.delete(id)
      setExpanded(next)
      return
    }
    next.add(id)
    setExpanded(next)
    // Fetch diff if not already loaded
    if (!diffs[id]) {
      setLoading((l) => ({ ...l, [id]: true }))
      try {
        const res = await apiFetch(`/projects/${projectId || project?.project_id}/tasks/${id}/diff`)
        const data = await res.json()
        setDiffs((d) => ({ ...d, [id]: Array.isArray(data?.files) ? data.files : [] }))
      } catch {
        setDiffs((d) => ({ ...d, [id]: [] }))
      } finally {
        setLoading((l) => ({ ...l, [id]: false }))
      }
    }
  }

  const revertTaskStart = async (id) => {
    try {
      const ok = window.confirm('Revert to task start? This will restore the project to the snapshot at the beginning of this task.')
      if (!ok) return
      const resp = await apiFetch(`/projects/${projectId || project?.project_id}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: { type: 'tags', all: ['task', 'task_start', `task_id:${id}`] }, resume: false })
      })
      if (!resp.ok) {
        const text = await resp.text()
        alert(`Revert failed: ${resp.status} ${text}`)
      }
    } catch (e) {
      alert(`Revert error: ${e}`)
    }
  }

  const StatusIcon = ({ status }) => {
    if (status === 'completed') return <CheckCircle className="w-4 h-4 text-green-400" />
    if (status === 'failed') return <XCircle className="w-4 h-4 text-red-400" />
    if (status === 'in_progress') return <Loader className="w-4 h-4 text-blue-400 animate-spin" />
    if (status === 'claimed') return <Clock className="w-4 h-4 text-blue-400" />
    if (status === 'skipped') return <Clock className="w-4 h-4 text-amber-400" />
    return <Clock className="w-4 h-4 text-slate-400" />
  }

  const StatusBadge = ({ status }) => {
    const map = {
      completed: 'bg-green-900/30 text-green-300 border-green-700/50',
      failed: 'bg-red-900/30 text-red-300 border-red-700/50',
      in_progress: 'bg-blue-900/30 text-blue-300 border-blue-700/50',
      claimed: 'bg-blue-900/30 text-blue-300 border-blue-700/50',
      skipped: 'bg-amber-900/30 text-amber-300 border-amber-700/50',
      pending: 'bg-slate-900/30 text-slate-300 border-slate-700/50',
    }
    const labelMap = {
      completed: 'Completed',
      failed: 'Failed',
      in_progress: 'In Progress',
      claimed: 'Assigned',
      skipped: 'Skipped',
      pending: 'Pending',
    }
    const cls = map[status] || map.pending
    const label = labelMap[status] || 'Pending'
    return <span className={`px-2 py-0.5 text-xs rounded border ${cls}`}>{label}</span>
  }

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      {tasks.length === 0 ? (
        <div className="text-slate-400 text-sm">No tasks available</div>
      ) : (
        <ul className="divide-y divide-slate-700/60">
          {tasks.map((t) => {
            const isOpen = expanded.has(t.id)
            const isLoading = !!loading[t.id]
            const files = diffs[t.id] || []
            return (
              <li key={t.id} className="py-2">
                <div className="flex items-start gap-3">
                  <button
                    className="mt-0.5 text-slate-400 hover:text-slate-200"
                    onClick={() => toggle(t.id)}
                    title={isOpen ? 'Collapse' : 'Expand'}
                  >
                    {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  <div className="mt-0.5"><StatusIcon status={t.status} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-slate-100 text-sm font-medium whitespace-normal break-words">{t.description}</div>
                      <StatusBadge status={t.status} />
                      {t.type && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-900/40 text-slate-300 border border-slate-700/50">{t.type}</span>
                      )}
                      <button
                        onClick={() => revertTaskStart(t.id)}
                        className="ml-auto inline-flex items-center gap-1 bg-yellow-700 hover:bg-yellow-600 text-white text-[11px] px-2 py-1 rounded"
                        title="Revert to task start"
                      >
                        <RotateCcw className="w-3 h-3" /> Revert to start
                      </button>
                    </div>
                    {(t.agent_id || t.agent_type || t.agent_display_name) && (
                      <div className="mt-1 text-xs text-slate-400 flex items-center gap-1">
                        <User className="w-3 h-3" />
                        <span>{t.agent_display_name || t.agent_id}</span>
                        {t.agent_type && <span className="text-slate-500">({t.agent_type})</span>}
                        {typeof t.attempts === 'number' && t.attempts > 1 && (
                          <span className="ml-2 text-slate-500">attempts: {t.attempts}</span>
                        )}
                      </div>
                    )}
                    {isOpen && (
                      <div className="mt-2 bg-slate-900/60 border border-slate-700/60 rounded p-3">
                        <div className="flex items-center gap-2 text-slate-300 text-xs mb-2">
                          <FileDiff className="w-4 h-4" /> Changed files
                        </div>
                        {isLoading ? (
                          <div className="text-slate-400 text-xs flex items-center gap-2"><Loader className="w-4 h-4 animate-spin" /> Loading...</div>
                        ) : files.length === 0 ? (
                          <div className="text-slate-500 text-xs">No changes recorded for this task</div>
                        ) : (
                          <ul className="text-xs text-slate-300 space-y-1">
                            {files.map((f, i) => (
                              <li key={i} className="flex items-center gap-2">
                                <span className={`px-1.5 py-0.5 rounded border text-[10px] ${
                                  f.status === 'A' ? 'bg-green-900/30 text-green-300 border-green-700/50' :
                                  f.status === 'D' ? 'bg-red-900/30 text-red-300 border-red-700/50' :
                                  'bg-blue-900/30 text-blue-300 border-blue-700/50'
                                }`}>{f.status}</span>
                                <span className="font-mono break-all">{f.path}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
