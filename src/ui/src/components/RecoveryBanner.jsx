import { useState } from 'react'
import { AlertTriangle, RefreshCw, Loader, CheckCircle, XCircle, Server, Cloud } from 'lucide-react'
import { apiFetch } from '../utils_api'

export default function RecoveryBanner({ project, onRecoveryComplete }) {
  const [recovering, setRecovering] = useState(false)
  const [recoveryResult, setRecoveryResult] = useState(null)
  const [error, setError] = useState(null)

  if (!project) return null

  // Active GET path historically only set needs_recovery; lazy load sets
  // needs_container_recovery. Session lockout after failed /recover uses either.
  const needsContainerRecovery = Boolean(
    project.needs_container_recovery || project.needs_recovery
  )
  const needsDeploymentRecovery = project.needs_deployment_recovery
  const artifactCount = project.artifact_count || 0
  const recoveryPrompt = project.recovery_prompt

  // No recovery needed
  if (!needsContainerRecovery && !needsDeploymentRecovery) return null

  const handleContainerRecovery = async () => {
    setRecovering(true)
    setError(null)
    setRecoveryResult(null)

    try {
      const res = await apiFetch(`/projects/${project.project_id}/recover`, {
        method: 'POST',
      })
      const data = await res.json()

      if (data.status === 'ready') {
        const mode = data.recovery_mode
        let message
        if (mode === 'reopen') {
          message = 'Environment reconnected — packages, /tmp and uncommitted files kept.'
        } else if (mode === 'replace') {
          message =
            'Environment rebuilt from the git branch. Packages, /tmp and uncommitted files are gone; re-install and re-fetch before continuing.'
        } else {
          message = `Environment restored! ${data.files_restored || 0} files recovered.`
        }
        setRecoveryResult({
          success: true,
          message,
        })
        if (onRecoveryComplete) {
          setTimeout(() => onRecoveryComplete(), 1500)
        }
      } else if (data.status === 'simulated') {
        setRecoveryResult({
          success: true,
          message: 'Container-use is unavailable, running in simulation mode.',
        })
      } else {
        setError(data.reason || 'Recovery failed')
      }
    } catch (err) {
      setError(err.message || 'Recovery request failed')
    } finally {
      setRecovering(false)
    }
  }

  const handleRedeployment = async () => {
    // TODO: Implement redeployment trigger
    // For now, just inform the user
    alert('Redeployment will be available soon. Please use the deploy action from the chat.')
  }

  return (
    <div className="mb-4 space-y-3">
      {/* Container Recovery Banner */}
      {needsContainerRecovery && !recoveryResult?.success && (
        <div className="p-4 rounded-lg border border-amber-600/50 bg-amber-900/20">
          <div className="flex items-start gap-3">
            <Server className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-100 mb-1">
                Project Environment Needs Recovery
              </div>
              <div className="text-xs text-amber-300/80 mb-3">
                {artifactCount > 0 ? (
                  <>We have <strong>{artifactCount} files</strong> saved that can be restored to continue your work.</>
                ) : (
                  <>Your container environment is not available. We can create a fresh environment for you.</>
                )}
              </div>
              
              {error && (
                <div className="text-xs text-red-300 mb-2 flex items-center gap-1">
                  <XCircle className="w-3 h-3" />
                  {error}
                </div>
              )}
              
              <button
                onClick={handleContainerRecovery}
                disabled={recovering}
                className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-800 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded transition-colors"
              >
                {recovering ? (
                  <>
                    <Loader className="w-3 h-3 animate-spin" />
                    <span>Recovering...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3 h-3" />
                    <span>Restore Environment</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recovery Success Banner */}
      {recoveryResult?.success && (
        <div className="p-4 rounded-lg border border-green-600/50 bg-green-900/20">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-green-100 mb-1">
                Recovery Complete
              </div>
              <div className="text-xs text-green-300/80">
                {recoveryResult.message}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deployment Recovery Banner */}
      {needsDeploymentRecovery && (
        <div className="p-4 rounded-lg border border-blue-600/50 bg-blue-900/20">
          <div className="flex items-start gap-3">
            <Cloud className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-blue-100 mb-1">
                Deployment Unavailable
              </div>
              <div className="text-xs text-blue-300/80 mb-3">
                Your previous deployment is no longer accessible. Would you like to redeploy?
              </div>
              
              <button
                onClick={handleRedeployment}
                className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Redeploy</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
