import { CheckCircle2, AlertCircle, Rocket } from 'lucide-react'

function normalizeStatus(value) {
  if (!value) return 'unknown'
  return String(value).toLowerCase()
}

function statusTone(status) {
  if (status === 'succeeded' || status === 'success') {
    return {
      text: 'text-emerald-200',
      badge: 'bg-emerald-900/40 border-emerald-700/70 text-emerald-200',
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
    }
  }

  if (status === 'failed' || status === 'error') {
    return {
      text: 'text-rose-200',
      badge: 'bg-rose-900/40 border-rose-700/70 text-rose-200',
      icon: <AlertCircle className="h-4 w-4 text-rose-400" />,
    }
  }

  return {
    text: 'text-slate-200',
    badge: 'bg-slate-800 border-slate-700 text-slate-200',
    icon: <Rocket className="h-4 w-4 text-blue-400" />,
  }
}

export default function DeployCard({ data }) {
  const status = normalizeStatus(data?.deploy_status || data?.deployment_status)
  const tone = statusTone(status)
  const url = data?.url
  const error = data?.error
  const recommendation = data?.recommendation
  const needsDelegation = Boolean(data?.needs_delegation)

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-4">
      <div className="flex items-center gap-2">
        {tone.icon}
        <h3 className="text-sm font-semibold text-slate-100">Deployment</h3>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">Status:</span>
        <span className={`text-xs px-2 py-0.5 rounded border uppercase tracking-wide ${tone.badge}`}>
          {status}
        </span>
      </div>

      {url && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <p className="text-xs text-slate-400 mb-1">URL</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-sm break-all underline ${tone.text}`}
          >
            {url}
          </a>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-700/70 bg-rose-900/20 p-3">
          <p className="text-xs font-semibold text-rose-200 mb-1">Error</p>
          <p className="text-sm text-rose-100 whitespace-pre-wrap">{String(error)}</p>
        </div>
      )}

      {recommendation && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <p className="text-xs font-semibold text-slate-200 mb-1">Recommendation</p>
          <p className="text-sm text-slate-100 whitespace-pre-wrap">{String(recommendation)}</p>
        </div>
      )}

      {needsDelegation && (
        <p className="text-xs text-amber-300">Needs delegation: yes</p>
      )}

      {!url && !error && !recommendation && !needsDelegation && (
        <p className="text-xs text-slate-400">No additional deployment details.</p>
      )}
    </div>
  )
}
