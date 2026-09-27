import { useEffect, useMemo, useState } from 'react'

import { apiFetch } from '../../utils_api'

export async function fetchRunDetail(projectId, runId, request = apiFetch) {
  const response = await request('/projects/' + projectId + '/runs/' + encodeURIComponent(runId))
  if (!response.ok) throw new Error('Run request failed (' + response.status + ')')
  return response.json()
}

export default function useRunNavigation({ projectId, runs, activeRunId }) {
  const [loaded, setLoaded] = useState(null)
  const [loadState, setLoadState] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const knownRuns = useMemo(() => {
    const loadedRuns = loaded?.projectId === projectId ? loaded.runs : []
    return [...runs, ...loadedRuns.filter((run) => !runs.some((item) => item.run_id === run.run_id))]
  }, [loaded, projectId, runs])
  const missingRunId = [activeRunId].find(
    (id) => id && !knownRuns.some((run) => run.run_id === id),
  )
  const requestKey = missingRunId ? projectId + ':' + missingRunId : null

  useEffect(() => {
    if (!missingRunId) return undefined
    let cancelled = false
    setLoadState({ requestKey, status: 'loading' })
    fetchRunDetail(projectId, missingRunId)
      .then((run) => {
        if (cancelled) return
        setLoaded((previous) => ({
          projectId,
          runs: [...(previous?.projectId === projectId ? previous.runs : [])
            .filter((item) => item.run_id !== run.run_id), run],
        }))
      })
      .catch(() => {
        if (!cancelled) setLoadState({ requestKey, status: 'error' })
      })
    return () => { cancelled = true }
  }, [projectId, missingRunId, requestKey, attempt])

  function resetNavigation() {
    setLoaded(null)
  }

  return {
    knownRuns,
    resetNavigation,
    missingRunId,
    loadFailed: Boolean(requestKey && loadState?.requestKey === requestKey && loadState.status === 'error'),
    retry: () => setAttempt((value) => value + 1),
  }
}
