import { Terminal } from 'lucide-react'
import { useState } from 'react'
import { apiFetch } from '../../utils_api'
import { notify } from '../../utils_notify'

export default function OverviewTab({ project }) {
  if (!project) return null

  const deployments = Array.isArray(project.deployments) ? project.deployments : []
  const latest = deployments.length ? deployments[deployments.length - 1] : null

  return (
    <div>
      {/* Project Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-slate-800 rounded-lg p-6">
          <h3 className="text-sm font-medium text-slate-400 mb-1">Status</h3>
          <p className="text-2xl font-semibold text-slate-100">{project.status}</p>
        </div>
        <div className="bg-slate-800 rounded-lg p-6">
          <h3 className="text-sm font-medium text-slate-400 mb-1">Phase</h3>
          <p className="text-2xl font-semibold text-slate-100">{project.current_phase || 'N/A'}</p>
        </div>
        <div className="bg-slate-800 rounded-lg p-6">
          <h3 className="text-sm font-medium text-slate-400 mb-1">Artifacts</h3>
          <p className="text-2xl font-semibold text-slate-100">{project.artifacts?.length || 0}</p>
        </div>
      </div>

      {/* Container Info */}
      {(project.environment_id || project.repo_path) && (
        <div className="bg-slate-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-slate-100 mb-4">Container Environment</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-slate-400">Environment ID</div>
              <div className="text-slate-200 font-mono">{project.environment_id || 'N/A'}</div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Repo Path</div>
              <div className="text-slate-200 break-all font-mono text-sm">{project.repo_path || 'N/A'}</div>
            </div>
          </div>
          {project.environment_id && (
            <div className="mt-4 p-4 bg-slate-900 rounded-lg">
              <div className="text-sm text-slate-400 mb-2">Host Commands:</div>
              <div className="space-y-1 font-mono text-xs">
                <div className="text-slate-300">cu log {project.environment_id}</div>
                <div className="text-slate-300">cu checkout {project.environment_id}</div>
                <div className="text-slate-300">cu apply {project.environment_id}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Deployments */}
      <div className="bg-slate-800 rounded-lg p-6 mt-6">
        <h3 className="text-lg font-semibold text-slate-100 mb-3">Deployments</h3>
        <p className="text-sm text-slate-300 mb-3">
          Overall deploy status: <span className="font-mono text-xs">{project.deploy_status || 'not_started'}</span>
        </p>
        {!deployments.length ? (
          <p className="text-sm text-slate-400">No deployments recorded yet.</p>
        ) : (
          <DeploymentDetails projectId={project.project_id} latest={latest} deployments={deployments} />
        )}
      </div>
    </div>
  )
}

function DeploymentDetails({ projectId, latest, deployments }) {
  const [adminKey, setAdminKey] = useState('')
  const [busy, setBusy] = useState(false)
  const ingressHost = latest?.ingress_host || latest?.host || ''
  const health = latest?.health || {}
  const healthStatus = health.status || 'unknown'
  const healthDetails = health.details || ''
  const status = latest?.status || 'unknown'
  const updatedAt = latest?.updated_at || latest?.created_at || ''
  const url = ingressHost ? `https://${ingressHost}/` : null

  const latestId = latest?.deployment_id || ''
  const buildSteps = Array.isArray(latest?.build_steps) ? latest.build_steps : null
  const diagnostics = latest?.diagnostics || null

  const canRetry = latestId && String(status).toLowerCase() === 'failed'

  const doRetry = async () => {
    if (!latestId) return
    if (!adminKey) {
      notify({ title: 'Missing admin key', message: 'Set X-Deploy-Admin-Key first.', variant: 'warning', ttl: 4500 })
      return
    }
    setBusy(true)
    try {
      const resp = await apiFetch(`/admin/projects/${projectId}/deployments/${latestId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Deploy-Admin-Key': adminKey },
        body: JSON.stringify({})
      })
      if (!resp.ok) {
        const txt = await resp.text()
        notify({ title: 'Retry failed', message: `${resp.status}: ${txt}`.slice(0, 400), variant: 'error', ttl: 7000 })
        return
      }
      notify({ title: 'Retry started', message: 'Deployment retry triggered.', variant: 'success', ttl: 3000 })
    } catch (e) {
      notify({ title: 'Retry error', message: String(e).slice(0, 400), variant: 'error', ttl: 7000 })
    } finally {
      setBusy(false)
    }
  }

  const doRollback = async (targetId) => {
    if (!targetId) return
    if (!adminKey) {
      notify({ title: 'Missing admin key', message: 'Set X-Deploy-Admin-Key first.', variant: 'warning', ttl: 4500 })
      return
    }
    setBusy(true)
    try {
      const resp = await apiFetch(`/admin/projects/${projectId}/deployments/${targetId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Deploy-Admin-Key': adminKey },
        body: JSON.stringify({})
      })
      if (!resp.ok) {
        const txt = await resp.text()
        notify({ title: 'Rollback failed', message: `${resp.status}: ${txt}`.slice(0, 400), variant: 'error', ttl: 7000 })
        return
      }
      notify({ title: 'Rollback started', message: 'Rollback triggered.', variant: 'success', ttl: 3000 })
    } catch (e) {
      notify({ title: 'Rollback error', message: String(e).slice(0, 400), variant: 'error', ttl: 7000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
        <span className="text-slate-400">Latest deployment status:</span>
        <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-900 border border-slate-700">{status}</span>
        {updatedAt && <span className="text-xs text-slate-500">updated {updatedAt}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
        <span className="text-slate-400">Health:</span>
        <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-900 border border-slate-700">{healthStatus}</span>
        {healthDetails && (
          <span className="text-xs text-slate-400 truncate max-w-xs" title={healthDetails}>{healthDetails}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
        <span className="text-slate-400">Domain:</span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline break-all text-xs">{url}</a>
        ) : (
          <span className="text-slate-400 text-xs">n/a</span>
        )}
      </div>
      <div className="mt-4 border-t border-slate-700 pt-3">
        <div className="text-xs font-semibold text-slate-400 mb-2">Deployment history</div>
        <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
          {deployments.slice().reverse().map((d, idx) => {
            const host = d.ingress_host || d.host || ''
            const histUrl = host ? `https://${host}/` : null
            const isSucceeded = String(d.status || '').toLowerCase() === 'succeeded'
            return (
              <div key={d.deployment_id || idx} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-slate-900 border border-slate-700">{d.status || 'unknown'}</span>
                {d.created_at && <span className="text-slate-500">{d.created_at}</span>}
                {histUrl && (
                  <a href={histUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline break-all">{histUrl}</a>
                )}
                {isSucceeded && d.deployment_id && (
                  <button
                    onClick={() => doRollback(d.deployment_id)}
                    disabled={busy || !adminKey}
                    className="text-[11px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-slate-200"
                    title="Rollback to this deployment"
                  >
                    Rollback
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
