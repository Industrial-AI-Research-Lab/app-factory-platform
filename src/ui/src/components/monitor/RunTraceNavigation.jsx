import { useId, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import RunSourcePanel from './RunSourcePanel'

function sourceRun(run) {
  const restoredId = run?.restored_from?.run_id
  if (typeof restoredId === 'string' && restoredId.trim())
    return {
      id: restoredId, label: 'Continued from Run', restored: true,
      pointId: typeof run.restored_from.point_id === 'string' && run.restored_from.point_id.trim()
        ? run.restored_from.point_id : null,
    }
  const parentId = run?.parent_run_id
  if (typeof parentId === 'string' && parentId.trim())
    return { id: parentId, label: 'Parent Run' }
  return null
}

export default function RunTraceNavigation({ projectId, run }) {
  const [openedSource, setOpenedSource] = useState(null)
  const triggerRef = useRef(null)
  const panelId = useId()
  const source = sourceRun(run)
  const sourceKey = JSON.stringify([projectId, run?.run_id, source?.id, source?.pointId])
  const isOpen = openedSource === sourceKey
  const closeSource = () => {
    setOpenedSource(null)
    triggerRef.current?.focus()
  }
  const hasTrace = typeof run?.trace_url === 'string' && run.trace_url.trim()
  if (!hasTrace && !source) return null

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      {hasTrace && (
        <a
          href={run.trace_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center gap-1 text-blue-400 underline underline-offset-2 hover:text-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          Open in Jaeger
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
      {source && (
        <div className="min-w-0 basis-full space-y-1">
          <p className="break-all text-slate-300">{source.label}: {source.id}</p>
          {source.pointId && <p className="break-all text-slate-300">Checkpoint: {source.pointId}</p>}
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={isOpen}
            aria-controls={isOpen ? panelId : undefined}
            onClick={(event) => {
              event.stopPropagation()
              if (isOpen) closeSource()
              else setOpenedSource(sourceKey)
            }}
            className="text-left text-blue-300 underline underline-offset-2 hover:text-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            {isOpen ? 'Hide source' : 'View source'}
          </button>
          {isOpen && <RunSourcePanel key={sourceKey} projectId={projectId} source={source} id={panelId} onClose={closeSource} />}
        </div>
      )}
    </div>
  )
}
