import { useEffect, useRef, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'

import { apiFetch } from '../../utils_api'
import { fetchRunDetail } from './useRunNavigation'

export async function fetchSourceCheckpoint(projectId, runId, pointId, request = apiFetch) {
  const response = await request('/projects/' + projectId + '/runs/' + encodeURIComponent(runId) + '/points?limit=1000')
  if (!response.ok) throw new Error('Checkpoint request failed (' + response.status + ')')
  const data = await response.json()
  return data.points?.find((point) => point.point_id === pointId) || null
}

export default function RunSourcePanel({ projectId, source, id, onClose }) {
  const headingRef = useRef(null)
  const [state, setState] = useState({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const { id: runId, pointId, restored } = source

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
    headingRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetchRunDetail(projectId, runId).then(async (run) => {
      if (cancelled) return
      setState({ status: 'loaded', run, checkpointLoading: Boolean(pointId) })
      if (!pointId) return
      try {
        const point = await fetchSourceCheckpoint(projectId, runId, pointId)
        if (!cancelled) setState({ status: 'loaded', run, point })
      } catch {
        if (!cancelled) setState({ status: 'loaded', run, checkpointFailed: true })
      }
    }).catch(() => {
      if (!cancelled) setState({ status: 'error' })
    })
    return () => { cancelled = true }
  }, [projectId, runId, pointId, attempt])

  const traceUrl = state.run?.trace_url
  const hasTrace = typeof traceUrl === 'string' && traceUrl.trim()
  const retry = () => setAttempt((value) => value + 1)

  return (
    <section
      id={id}
      aria-label="Source Run"
      className="mt-3 min-w-0 border-t border-slate-600 pt-4 text-sm text-slate-200"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 ref={headingRef} tabIndex={-1} className="rounded font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400">
          Source Run
        </h4>
        <button type="button" onClick={onClose} aria-label="Close source" className="rounded p-1 text-slate-300 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-400">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-2 max-w-prose text-slate-300">
        {restored
          ? 'This Run was created by restoring a checkpoint from the source below.'
          : 'This Run was forked from the source below.'}
        {' '}Viewing the source keeps your active Run and chat unchanged.
      </p>
      <p className="mt-3 break-all font-mono text-xs">{runId}</p>
      <div role="status" className="mt-2 space-y-2">
        {state.status === 'loading' && <p>Loading source Run…</p>}
        {state.status === 'error' && (
          <p className="text-amber-300">Could not load the source Run. It may have been deleted or you may no longer have access.</p>
        )}
        {state.run && (
          <>
            <p>Phase: {state.run.workflow_phase || 'unknown'} · Status: {state.run.run_status || 'unknown'}</p>
            {hasTrace ? (
              <a href={traceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-300 underline underline-offset-2 hover:text-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-400">
                Open source in Jaeger <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : <p className="text-slate-300">No trace link is available for this source Run.</p>}
          </>
        )}
        {restored && (
          <div className="pt-2">
            <h5 className="font-medium">Restored checkpoint</h5>
            <p className="mt-1 break-all font-mono text-xs">{pointId || 'Checkpoint ID was not recorded.'}</p>
            {state.checkpointLoading && <p className="mt-1">Loading checkpoint details…</p>}
            {state.point?.label && <p className="mt-1 break-words">{state.point.label}</p>}
            {state.point?.time && <p className="mt-1 break-all text-xs">Saved: {state.point.time}</p>}
            {state.checkpointFailed && (
              <p className="mt-1 text-amber-300">Could not load checkpoint details. Try again.</p>
            )}
            {pointId && state.status === 'loaded' && !state.checkpointLoading && !state.checkpointFailed && !state.point && (
              <p className="mt-1 text-slate-300">Checkpoint details are unavailable. The ID above is the recorded restore point.</p>
            )}
          </div>
        )}
      </div>
      {(state.status === 'error' || state.checkpointFailed) && (
        <button type="button" onClick={retry} className="mt-2 text-blue-300 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-blue-400">
          Retry source
        </button>
      )}
    </section>
  )
}
