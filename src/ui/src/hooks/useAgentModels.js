import { useEffect, useState } from 'react'
import { apiFetch } from '../utils_api'
import { buildModelIndex } from '../utils/eventEnrichment'

/**
 * Per-run model index for the Events tab. Events carry no model, so this pulls
 * the run's agent_llm_calls once (one additive GET) and indexes them for
 * eventEnrichment to join. Fault-tolerant by design: no project, a failed fetch,
 * a 404, or an empty run all yield an empty index, so rows simply render without
 * a model (never a thrown error or a wrong/borrowed model).
 */
export default function useAgentModels(projectId, runId) {
  const [index, setIndex] = useState(() => buildModelIndex([]))
  useEffect(() => {
    if (!projectId) {
      setIndex(buildModelIndex([]))
      return undefined
    }
    let alive = true
    const params = new URLSearchParams({ limit: '500' })
    if (runId) params.set('run_id', runId)
    apiFetch(`/projects/${projectId}/agent-llm-calls?${params.toString()}`)
      .then((res) => (res && res.ok ? res.json() : null))
      .then((json) => { if (alive) setIndex(buildModelIndex(json?.items || [])) })
      .catch(() => { if (alive) setIndex(buildModelIndex([])) })
    return () => { alive = false }
  }, [projectId, runId])
  return index
}
