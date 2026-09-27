import { apiFetch } from '../utils_api'
import { notify } from '../utils_notify'

/**
 * Custom hook for project action handlers (approve, cancel, stop, revert).
 */
export default function useProjectActions({
  projectId,
  project,
  setProject,
  pendingApproval,
  setPendingApproval,
  setStopped,
  setStoppedReason,
  setIsExecuting,
  setIsReverting,
  setConfirmState,
  finalizedRef,
}) {

  const handleApproval = async (approved, message = null, reason = '') => {
    // Use message data if provided (from clicking approval card), otherwise fall back to global pendingApproval
    const approvalSource = message?.data || pendingApproval?.data
    if (!approvalSource) return

    // Get approval_id from data (single source of truth - no separate metadata)
    // Fallback to approvalSource for SSE events, then project.pending_approvals
    let currentApprovalId = message?.data?.approval_id || approvalSource?.approval_id || ''
    
    if (!currentApprovalId || currentApprovalId.includes('_')) {
      // approval_id not found or is a fake id like "projectId_requirements"
      // Try to find real approval_id from project.pending_approvals
      const gateType = message?.subtype || approvalSource?.type || ''
      const pendingList = project?.pending_approvals || []
      const match = pendingList.find(a => (a.gate_type || a.type) === gateType && a.status !== 'resolved')
      if (match?.approval_id) {
        currentApprovalId = match.approval_id
      }
    }
    
    const runId = approvalSource?.run_id || project?.active_run_id || project?.run_id || ''

    try {
      let endpoint = ''
      if (currentApprovalId && !currentApprovalId.includes('_')) {
        // Use run-scoped endpoint if run_id available, otherwise use simple approval endpoint
        if (runId) {
          endpoint = `/projects/${projectId}/runs/${runId}/approvals/${currentApprovalId}/resolve`
        } else {
          endpoint = `/projects/${projectId}/approvals/${currentApprovalId}/resolve`
        }
      } else {
        endpoint = `/projects/${projectId}/approve/${approvalSource.type}`
      }
      
      const resp = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved,
          feedback: message?.approval_feedback || reason || (approved ? 'Approved' : 'Rejected'),
          interaction_response: message?.interaction_response,
          expected_data: approvalSource,
        })
      })

      if (!resp.ok) {
        const text = await resp.text()
        console.error('Approval failed:', resp.status, text)
        if (resp.status === 404 && /Approval not found/i.test(text) && pendingApproval?.data?.type === 'output') {
          try { localStorage.setItem(`output_approved_${projectId}`, 'true') } catch {}
          setPendingApproval(null)
          notify({ title: 'Output recorded', message: 'Output preview closed (approval not tracked on server).', variant: 'success', ttl: 3500 })
          apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data))
          return
        }
        notify({ title: 'Approval failed', message: `${resp.status}: ${text}`.slice(0, 400), variant: 'error', ttl: 7000 })
        return
      }

      setPendingApproval(prev => {
        if (!prev) return prev
        const activeId = prev?.data?.approval_id || ''
        if (currentApprovalId && activeId && activeId !== currentApprovalId) return prev
        return null
      })

      try {
        const type = pendingApproval?.data?.type
        if (type === 'output' && approved) {
          localStorage.setItem(`output_approved_${projectId}`, 'true')
          notify({ title: 'Output approved', message: 'Continuing with project wrap-up.', variant: 'success', ttl: 2500 })
        } else if (type && !approved) {
          notify({ title: `${type} rejected`, message: 'Feedback recorded.', variant: 'warning', ttl: 2500 })
        }
      } catch {}

      apiFetch(`/projects/${projectId}`).then(res => res.json()).then(data => setProject(data))
    } catch (error) {
      console.error('Error submitting approval:', error)
      notify({ title: 'Submit failed', message: String(error), variant: 'error', ttl: 6000 })
    }
  }

  const cancelProject = async () => {
    try {
      setStopped(true)
      setStoppedReason('Cancelled by user')
      setProject(prev => prev ? { ...prev, status: 'cancelled' } : prev)
      setIsExecuting(false)
      finalizedRef.current = true
      notify({ title: 'Project cancelled', message: 'You stopped the execution.', variant: 'warning', ttl: 4000 })
      await apiFetch(`/projects/${projectId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Cancelled by user from UI' })
      })
      apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data))
    } catch (e) {
      notify({ title: 'Cancel failed', message: String(e), variant: 'error', ttl: 6000 })
    }
  }

  const doStopOnly = async () => {
    try {
      setStopped(true)
      setStoppedReason('Stopped by user')
      setProject(prev => prev ? { ...prev, status: 'cancelled' } : prev)
      setIsExecuting(false)
      finalizedRef.current = true
      notify({ title: 'Execution stopped', message: 'Project execution has been stopped.', variant: 'warning', ttl: 4000 })
      await apiFetch(`/projects/${projectId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Stopped by user' })
      })
      apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data))
    } catch (e) {
      notify({ title: 'Stop failed', message: String(e), variant: 'error', ttl: 6000 })
    }
  }

  const stopOnly = () => {
    setConfirmState({
      open: true,
      title: 'Stop current execution?',
      message: 'This will cancel the current run. You can revert to your last user message later.',
      confirmLabel: 'Stop',
      variant: 'danger',
      onConfirm: async () => { setConfirmState(s => ({ ...s, open: false })); await doStopOnly() }
    })
  }

  const doStopAndRevertToUserAction = async () => {
    try {
      setIsReverting(true)
      setStopped(true)
      setStoppedReason('Stopping and reverting to previous user action...')
      notify({ title: 'Reverting...', message: 'Restoring previous user action', variant: 'info', ttl: 2500 })
      const resp = await apiFetch(`/projects/${projectId}/stop-and-revert-latest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Stopped and revert to previous user action' })
      })
      if (!resp.ok) {
        const text = await resp.text()
        notify({ title: 'Revert failed', message: `${resp.status}: ${text}`.slice(0, 400), variant: 'error', ttl: 6000 })
      } else {
        notify({ title: 'Reverted', message: 'Project reverted to previous user action', variant: 'success', ttl: 3500 })
      }
      apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data))
    } catch (e) {
      notify({ title: 'Stop + Revert failed', message: String(e), variant: 'error', ttl: 6000 })
      setIsReverting(false)
    }
  }

  const stopAndRevertPreviousUserAction = async () => {
    try {
      const resp = await apiFetch(`/projects/${projectId}/revert/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { type: 'tags', all: ['user_action'] } })
      })
      let message = 'This will stop execution and restore the previous user action.'
      if (resp.ok) {
        const data = await resp.json()
        if (data?.message_for_user) message = data.message_for_user
        if (data?.prefill_input) message += `\n\nChat will be prefilled with:\n"${String(data.prefill_input).slice(0, 400)}"`
      }
      setConfirmState({
        open: true,
        title: 'Stop and revert to previous user action?',
        message,
        confirmLabel: 'Stop & Revert',
        variant: 'danger',
        onConfirm: async () => { setConfirmState(s => ({ ...s, open: false })); await doStopAndRevertToUserAction() },
      })
    } catch (e) {
      setConfirmState({
        open: true,
        title: 'Stop and revert to previous user action?',
        message: 'This will stop execution and restore the previous user action.',
        confirmLabel: 'Stop & Revert',
        variant: 'danger',
        onConfirm: async () => { setConfirmState(s => ({ ...s, open: false })); await doStopAndRevertToUserAction() }
      })
    }
  }

  const doRevertToSnapshot = async (id, resume = false) => {
    try {
      setIsReverting(true)
      notify({ title: 'Reverting...', message: 'Applying snapshot', variant: 'info', ttl: 2500 })
      const resp = await apiFetch(`/projects/${projectId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: { type: 'snapshot', id }, resume })
      })
      if (!resp.ok) {
        const text = await resp.text()
        notify({ title: 'Revert failed', message: `${resp.status}: ${text}`.slice(0, 400), variant: 'error', ttl: 6000 })
        return
      }
      setPendingApproval(null)
      notify({ title: 'Reverted', message: 'Snapshot applied', variant: 'success', ttl: 2500 })
      apiFetch(`/projects/${projectId}`).then(r => r.json()).then(data => setProject(data))
    } catch (e) {
      notify({ title: 'Revert failed', message: String(e), variant: 'error', ttl: 6000 })
      setIsReverting(false)
    }
  }

  const revertToSnapshot = (id, resume = false) => {
    setConfirmState({
      open: true,
      title: resume ? 'Revert and resume?' : 'Revert to this snapshot?',
      message: resume ? 'Apply this snapshot and continue running.' : 'Apply this snapshot to restore project state.',
      confirmLabel: resume ? 'Revert & Resume' : 'Revert',
      variant: 'danger',
      onConfirm: async () => { setConfirmState(s => ({ ...s, open: false })); await doRevertToSnapshot(id, resume) }
    })
  }

  const revertToLastUserMessage = async () => {
    await stopAndRevertPreviousUserAction()
  }

  return {
    handleApproval,
    cancelProject,
    doStopOnly,
    stopOnly,
    doStopAndRevertToUserAction,
    stopAndRevertPreviousUserAction,
    doRevertToSnapshot,
    revertToSnapshot,
    revertToLastUserMessage,
  }
}
