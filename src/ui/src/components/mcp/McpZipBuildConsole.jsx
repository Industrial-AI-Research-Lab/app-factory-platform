import { useEffect, useRef } from 'react'
import { Copy } from 'lucide-react'

const PHASE_LABELS = {
  build: 'docker build',
  smoke: 'smoke discover',
  done: 'complete',
  error: 'failed',
}

function phaseHeader(phase, status) {
  const key = String(phase || '').toLowerCase()
  const label = PHASE_LABELS[key] || key || 'log'
  if (status === 'ready') return `Phase: ${label} — success`
  if (status === 'image_ready' || status === 'smoke_running') return `Phase: ${label} — smoke test running`
  if (status === 'build_failed' || status === 'smoke_failed') return `Phase: ${label} — failed`
  return `Phase: ${label}`
}

export default function McpZipBuildConsole({ buildLog, buildStatus, busy, onCopy }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [buildLog])

  const smokeHint =
    buildStatus?.status === 'smoke_running' || buildStatus?.status === 'image_ready'
      ? 'Docker build finished. Running smoke test (start container + discover tools)…\n\n'
      : ''
  const buildingDocker =
    busy && (buildStatus?.phase === 'build' || buildStatus?.status === 'building')
  const idleHint = buildingDocker
    ? 'Docker build running… output appears here as it is produced.\n\n'
    : busy
      ? 'Starting build…\n\n'
      : ''
  const text = buildLog
    ? smokeHint + buildLog
    : (busy ? (smokeHint || idleHint) : '')
  const failed = buildStatus?.status === 'build_failed' || buildStatus?.status === 'smoke_failed'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-400 font-medium">
          {phaseHeader(buildStatus?.phase, buildStatus?.status)}
        </span>
        {text && (
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        )}
      </div>
      <pre
        className={`w-full max-h-[280px] overflow-y-auto bg-slate-900 border rounded px-3 py-2 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all ${
          failed ? 'border-red-800/60 text-red-100/90' : 'border-slate-600 text-slate-200'
        }`}
      >
        {text || '(empty)'}
        <span ref={endRef} />
      </pre>
      {failed && buildStatus?.error && (
        <p className="text-xs text-red-300">{buildStatus.error}</p>
      )}
    </div>
  )
}
