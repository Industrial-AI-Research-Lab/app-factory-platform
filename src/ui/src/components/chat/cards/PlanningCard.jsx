import { ListChecks } from 'lucide-react'
import { truncatePreviewText } from './previewUtils'

function normalizeTask(task, index) {
  if (typeof task === 'string') {
    return {
      id: `task-${index + 1}`,
      description: task,
      dependencies: [],
    }
  }

  return {
    id: task?.task_id || `task-${index + 1}`,
    description: task?.description || task?.name || `Task ${index + 1}`,
    dependencies: Array.isArray(task?.dependencies) ? task.dependencies : [],
  }
}

function previewText(value) {
  return truncatePreviewText(value).text
}

export default function PlanningCard({ data }) {
  const payload = data?.plan && typeof data.plan === 'object' ? data.plan : data
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : []
  const phases = Array.isArray(payload?.phases)
    ? payload.phases
    : payload?.phases && typeof payload.phases === 'object'
      ? Object.entries(payload.phases).map(([name, details]) => ({ name, details }))
      : []

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-semibold text-slate-100">Planning</h3>
      </div>

      {tasks.length > 0 ? (
        <div className="space-y-2">
          {tasks.map((task, index) => {
            const normalized = normalizeTask(task, index)
            return (
              <div key={normalized.id} className="rounded-lg border border-slate-700 bg-slate-800/70 p-3">
                <p className="text-xs text-slate-400">{previewText(normalized.id)}</p>
                <p className="text-sm text-slate-100 mt-1">{previewText(normalized.description)}</p>
                {normalized.dependencies.length > 0 && (
                  <p className="text-[11px] text-slate-400 mt-2">
                    Depends on: {previewText(normalized.dependencies.join(', '))}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-400">No tasks in this planning payload.</p>
      )}

      {phases.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
          <h4 className="text-xs font-semibold text-slate-200 mb-2">Phases</h4>
          <ul className="space-y-1">
            {phases.map((phase, index) => (
              <li key={`${phase.name || 'phase'}-${index}`} className="text-xs text-slate-300">
                {previewText(phase.name || `Phase ${index + 1}`)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
