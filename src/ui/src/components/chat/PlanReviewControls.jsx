import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { apiFetch } from '../../utils_api'

export default function PlanReviewControls({ data, projectId, approvalId, onRefined }) {
  const tasks = flattenPlanTasks(data?.context_snapshot?.plan?.tasks || data?.plan?.tasks || [])
  const [removeTaskIds, setRemoveTaskIds] = useState([])
  const [feedbackText, setFeedbackText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const toggleTask = (taskId) => {
    setRemoveTaskIds(prev => (
      prev.includes(taskId)
        ? prev.filter(id => id !== taskId)
        : [...prev, taskId]
    ))
  }

  const handleRequestChanges = async () => {
    if (submitting || (!feedbackText.trim() && removeTaskIds.length === 0)) return
    setSubmitting(true)
    setError('')
    const selectedTasks = tasks.filter(task => removeTaskIds.includes(task.id))
    const selectedText = selectedTasks.length
      ? selectedTasks.map(task => `- ${task.id}: ${task.description}`).join('\n')
      : '- none selected'
    const feedback = [
      'Plan review feedback:',
      `Tasks to remove:\n${selectedText}`,
      feedbackText.trim() ? `Requested changes:\n${feedbackText.trim()}` : '',
    ].filter(Boolean).join('\n\n')

    try {
      const resp = await apiFetch(`/projects/${projectId}/refine/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_id: approvalId,
          feedback,
          interaction_response: {
            interaction_type: 'plan_review',
            decision: 'revise',
            remove_task_ids: removeTaskIds,
            feedback_text: feedbackText.trim(),
          },
        }),
      })
      if (!resp.ok) {
        const text = await resp.text()
        setError(`${resp.status}: ${text}`.slice(0, 300))
        return
      }
      setRemoveTaskIds([])
      setFeedbackText('')
      if (onRefined) onRefined()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (!tasks.length) return null

  return (
    <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-4">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2">
          {tasks.map(task => (
            <label
              key={task.id}
              className="flex items-start gap-3 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-slate-200"
            >
              <input
                type="checkbox"
                checked={removeTaskIds.includes(task.id)}
                onChange={() => toggleTask(task.id)}
                className="mt-1 h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500 focus:ring-blue-500"
              />
              <span className="min-w-0 flex-1">
                <span className="mr-2 font-mono text-xs text-slate-400">{task.id}</span>
                <span className="break-words">{task.description}</span>
              </span>
            </label>
          ))}
        </div>
        <textarea
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          placeholder="Requested changes"
        />
        {error && (
          <div className="rounded-md border border-red-700/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}
        <button
          type="button"
          onClick={handleRequestChanges}
          disabled={submitting || (!feedbackText.trim() && removeTaskIds.length === 0)}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          <RotateCcw className="h-4 w-4" />
          {submitting ? 'Submitting...' : 'Request changes'}
        </button>
      </div>
    </div>
  )
}

function flattenPlanTasks(tasks, prefix = '') {
  const flat = []
  for (let index = 0; index < tasks.length; index += 1) {
    const rawTask = tasks[index]
    const task = typeof rawTask === 'string' ? { description: rawTask } : (rawTask || {})
    const id = String(task.task_id || task.id || `${prefix}${index + 1}`)
    flat.push({
      id,
      description: task.description || task.name || 'Unnamed task',
    })
    if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
      flat.push(...flattenPlanTasks(task.subtasks, `${id}.`))
    }
  }
  return flat
}
