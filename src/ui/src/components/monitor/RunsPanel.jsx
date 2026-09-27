import { apiFetch } from '../../utils_api'
import RunTraceNavigation from './RunTraceNavigation'
import useRunNavigation from './useRunNavigation'

export function currentRunIdOf(activeRunId, runs) {
  return activeRunId || runs.find((run) => run.active)?.run_id
}

export function isRunsPanelHidden(knownRuns, currentRunId) {
  return knownRuns.length === 0 && !currentRunId
}

export default function RunsPanel({
  projectId,
  activeRunId,
  runs,
  setRuns,
  setProject,
  showRunsPanel,
  setShowRunsPanel,
  setConfirmState,
}) {
  const currentRunId = currentRunIdOf(activeRunId, runs)
  const {
    knownRuns, resetNavigation, missingRunId, loadFailed, retry,
  } = useRunNavigation({
    projectId, runs, activeRunId: currentRunId,
  })
  if (isRunsPanelHidden(knownRuns, currentRunId)) return null
  const visibleRuns = showRunsPanel
    ? knownRuns
    : knownRuns.filter((run) => run.run_id === currentRunId)

  const activateRun = async (run) => {
    if (run.run_id === currentRunId) return
    try {
      await apiFetch('/projects/' + projectId + '/runs/' + encodeURIComponent(run.run_id) + '/activate', { method: 'POST' })
      const res = await apiFetch('/projects/' + projectId + '/runs')
      const data = await res.json()
      setRuns(data.runs || [])
      const projRes = await apiFetch('/projects/' + projectId)
      setProject(await projRes.json())
      resetNavigation()
    } catch (err) {
      console.error('Error activating run:', err)
    }
  }

  const deleteRun = async (run) => {
    try {
      await apiFetch('/projects/' + projectId + '/runs/' + encodeURIComponent(run.run_id) + '/delete', { method: 'POST' })
      const res = await apiFetch('/projects/' + projectId + '/runs')
      const data = await res.json()
      setRuns(data.runs || [])
      const projRes = await apiFetch('/projects/' + projectId)
      setProject(await projRes.json())
      resetNavigation()
    } catch (err) {
      console.error('Error deleting run:', err)
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Runs ({knownRuns.length})</h3>
        <button
          type="button"
          onClick={() => setShowRunsPanel(!showRunsPanel)}
          className="text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          {showRunsPanel ? 'Hide' : 'Show'}
        </button>
      </div>
      {missingRunId && (
        <div className="mb-3 flex min-w-0 flex-wrap gap-2 text-xs" role="status">
          <span className={loadFailed ? 'break-all text-amber-300' : 'break-all text-slate-300'}>
            {loadFailed ? 'Could not load Run: ' : 'Loading Run: '}{missingRunId}
          </span>
          {loadFailed && (
            <button type="button" onClick={retry} className="text-blue-400 underline underline-offset-2">
              Retry
            </button>
          )}
        </div>
      )}
      <div className="space-y-2">
        {visibleRuns.map((run) => {
          const isActive = run.run_id === currentRunId
          return (
            <div
              key={run.run_id}
              id={'run-' + run.run_id}
              role="group"
              aria-label={'Run ' + run.run_id}
              tabIndex={-1}
              className={'rounded border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 ' +
                (isActive
                  ? 'border-blue-600 bg-blue-900/30 text-blue-100'
                  : 'border-slate-600 bg-slate-700/30 text-slate-300 hover:bg-slate-700/50')}
            >
              <div className="flex cursor-pointer items-start justify-between gap-3" onClick={() => activateRun(run)}>
                <div className="min-w-0 flex-1">
                  <div className="break-all font-mono text-xs">{run.run_id}</div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    Phase: {run.workflow_phase || 'unknown'} • Status: {run.run_status || 'unknown'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isActive && <span className="text-[10px] font-semibold">ACTIVE</span>}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setConfirmState({
                        open: true,
                        title: 'Delete Run',
                        message: 'Are you sure you want to delete this run? This action cannot be undone.',
                        confirmLabel: 'Delete',
                        variant: 'danger',
                        onConfirm: async () => {
                          setConfirmState((state) => ({ ...state, open: false }))
                          await deleteRun(run)
                        },
                      })
                    }}
                    className="rounded border border-red-700 bg-red-900/30 px-2 py-1 text-xs text-red-300 hover:bg-red-900/50"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <RunTraceNavigation projectId={projectId} run={run} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
