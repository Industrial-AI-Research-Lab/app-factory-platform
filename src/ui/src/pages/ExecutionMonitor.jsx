import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useSearchParams, useLocation } from 'react-router-dom'
import { CheckCircle, XCircle, Clock, Loader, AlertCircle, Activity, Terminal, FileText, Package, Square, RotateCcw, ExternalLink, Settings } from 'lucide-react'

const DIAG_STORAGE_KEY = 'AppFactory:diag:open'
import { apiFetch } from '../utils_api'
import ConfirmDialog from '../components/ConfirmDialog'
import ContainerLogs from '../components/ContainerLogs'
import TabNavigation from '../components/TabNavigation'
import TopNavLinks from '../components/TopNavLinks'
import ChatInterface from '../components/ChatInterface'
import MapProgressStrip from '../components/chat/MapProgressStrip'
import DiagnosticDrawer from '../components/chat/DiagnosticDrawer'
import TaskStatusList from '../components/TaskStatusList'
import useProjectEvents from '../hooks/useProjectEvents'
import useProjectActions from '../hooks/useProjectActions'
import DelegationApprovalCard from '../components/chat/DelegationApprovalCard'
import { countEventLogDisplay } from '../utils/eventLogFilter'
import { planTasksBadge } from '../utils/planTaskStatusUtils'
import { OverviewTab, SnapshotsTab, EventsTab, ArtifactsTab, RunsPanel, TraceTab } from '../components/monitor'
import { currentRunIdOf, isRunsPanelHidden } from '../components/monitor/RunsPanel'
import RecoveryBanner from '../components/RecoveryBanner'
import ProjectLaunchSummary from '../components/ProjectLaunchSummary'
import { useAuth } from '../hooks/useAuth.jsx'

export default function ExecutionMonitor({ projectId: propProjectId }) {
  const { projectId: paramProjectId } = useParams()
  const projectId = propProjectId || paramProjectId
  return <ProjectExecutionMonitor key={projectId} projectId={projectId} />
}

function ProjectExecutionMonitor({ projectId }) {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const { user } = useAuth()
  
  const isCreating = searchParams.get('creating') === 'true'
  const rawPromptFromQuery = searchParams.get('prompt')
  let promptFromQueryDecoded = null
  if (rawPromptFromQuery) {
    try { promptFromQueryDecoded = decodeURIComponent(rawPromptFromQuery) } catch { promptFromQueryDecoded = rawPromptFromQuery }
  }
  const promptFromState = location.state && location.state.userPrompt
  const userPrompt = promptFromState || promptFromQueryDecoded

  const [project, setProject] = useState(() => {
    if (isCreating && userPrompt) {
      return { project_id: projectId, user_prompt: userPrompt, status: 'creating', created_at: new Date().toISOString() }
    }
    return null
  })

  const [sseNonce, setSseNonce] = useState(0)
  const [sinceOverride, setSinceOverride] = useState(null)
  const [confirmState, setConfirmState] = useState({ open: false, title: '', message: '', confirmLabel: 'Confirm', variant: 'danger', onConfirm: null })
  const [previewCollapsed, setPreviewCollapsed] = useState(false)
  const [runs, setRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [showRunsPanel, setShowRunsPanel] = useState(false)
  const [archiveRefs, setArchiveRefs] = useState([])
  const [displayTitle, setDisplayTitle] = useState('Project Execution')
  const animRef = useRef({ running: false })
  const summaryPollRef = useRef(null)

  // Diagnostic drawer state. Lifted here so a header toggle button and the
  // Ctrl+I keyboard shortcut both drive the same source of truth. Persists
  // across reloads, defaults to closed.
  const [diagOpen, setDiagOpen] = useState(() => {
    try { return window.localStorage.getItem(DIAG_STORAGE_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { window.localStorage.setItem(DIAG_STORAGE_KEY, diagOpen ? '1' : '0') } catch {}
  }, [diagOpen])
  useEffect(() => {
    function onKey(e) {
      // Ctrl+I toggle (Cmd+I on Mac). Chrome doesn't reserve this on Windows,
      // and the user's other diag shortcut Ctrl+Shift+D was already taken by
      // "Bookmark all tabs". preventDefault for safety on browsers that do
      // bind it (e.g. Safari Reader View).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        setDiagOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Custom hooks for event handling and actions
  const {
    events,
    allEventsForStreaming,
    mapProgress,
    setEvents,
    pendingApproval, setPendingApproval,
    pendingApprovals, setPendingApprovals,
    pendingDelegationApprovals, setPendingDelegationApprovals,
    authError, setAuthError,
    stopped, setStopped,
    stoppedReason, setStoppedReason,
    isExecuting, setIsExecuting,
    isReverting, setIsReverting,
    chatPrefill, setChatPrefill,
    messageResetNonce,
    finalizedRef, lastExecEventAtRef, lastSeenEventIdRef, notifiedFinalRef,
  } = useProjectEvents({ projectId, project, setProject, sinceOverride, sseNonce })

  const {
    handleApproval, cancelProject, doStopOnly, stopOnly,
    doStopAndRevertToUserAction, stopAndRevertPreviousUserAction,
    doRevertToSnapshot, revertToSnapshot, revertToLastUserMessage,
  } = useProjectActions({
    projectId, project, setProject,
    pendingApproval, setPendingApproval,
    setStopped, setStoppedReason,
    setIsExecuting, setIsReverting,
    setConfirmState, finalizedRef,
  })

  // Fetch project on mount
  useEffect(() => {
    if (projectId.startsWith('creating-')) return
    apiFetch(`/projects/${projectId}`)
      .then(res => res.json())
      .then(data => {
        setProject(data)
        try {
          const md = data?.metadata
          const candidate = (md && typeof md === 'object') ? md.last_revert_prefill : null
          if (typeof candidate === 'string' && candidate.trim()) {
            setChatPrefill(prev => prev && prev.trim() ? prev : candidate.trim())
          }
        } catch {}
      })
      .catch(err => console.error('Error fetching project:', err))
  }, [projectId])

  // Fetch runs
  useEffect(() => {
    if (projectId.startsWith('creating-')) return
    let cancelled = false
    setRuns([])
    setRunsLoading(true)
    apiFetch(`/projects/${projectId}/runs`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setRuns(data.runs || []) })
      .catch(err => console.error('Error fetching runs:', err))
      .finally(() => { if (!cancelled) setRunsLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  // Fetch archived tool-output spills (S3). Kept in its own state, not merged
  // into `project`: archive_refs come from a separate endpoint, so every
  // full-replace setProject (SSE lifecycle refetches, recovery) would drop them.
  useEffect(() => {
    if (projectId.startsWith('creating-')) return
    let cancelled = false
    apiFetch(`/projects/${projectId}/archive`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setArchiveRefs(Array.isArray(data?.refs) ? data.refs : []) })
      .catch(err => console.error('Error fetching archive refs:', err))
    return () => { cancelled = true }
  }, [projectId])

  // Animate title
  useEffect(() => {
    const newTitle = project?.title
    if (!newTitle) return
    if (animRef.current.running || displayTitle === newTitle) return
    animRef.current.running = true
    const eraseSpeed = 20, typeSpeed = 35
    let current = displayTitle
    const erase = () => new Promise((resolve) => {
      const tick = () => {
        if (current.length === 0) return resolve()
        current = current.slice(0, -1)
        setDisplayTitle(current || ' ')
        setTimeout(tick, eraseSpeed)
      }
      tick()
    })
    const type = () => new Promise((resolve) => {
      let idx = 0
      const tick = () => {
        if (idx > newTitle.length) return resolve()
        setDisplayTitle(newTitle.slice(0, idx))
        idx += 1
        setTimeout(tick, typeSpeed)
      }
      tick()
    })
    ;(async () => {
      try { await erase(); await type() } finally { animRef.current.running = false }
    })()
  }, [project?.title])

  // Deployment info
  const deploymentsSummary = Array.isArray(project?.deployments) ? project.deployments : []
  const latestDeployment = deploymentsSummary.length ? deploymentsSummary[deploymentsSummary.length - 1] : null
  const latestIngressHost = latestDeployment?.ingress_host || latestDeployment?.host || ''
  const latestDeploymentUrl = latestIngressHost ? `https://${latestIngressHost}/` : null
  const hasPreview = !!latestDeploymentUrl
  const showPreview = hasPreview && !previewCollapsed
  const chatPaneClass = showPreview ? 'flex-1 min-w-0 lg:w-1/2 lg:border-r lg:border-slate-700' : 'w-full min-w-0'
  const eventLogCount = useMemo(() => countEventLogDisplay(events), [events])

  const tasksBadge = useMemo(
    () => planTasksBadge(project?.plan?.tasks, events, { projectStatus: project?.status }),
    [events, project?.plan?.tasks, project?.status],
  )

  // Tab definitions
  const tabs = [
    {
      label: 'Chat', icon: <AlertCircle className="w-5 h-5" />, badge: pendingApproval ? '!' : null, fullBleed: true,
      content: (
        <div className="h-[calc(100vh-250px)] relative flex flex-col gap-2">
          {mapProgress.length > 0 && <MapProgressStrip progress={mapProgress} />}
          {hasPreview && previewCollapsed && (
            <div className="hidden lg:flex absolute top-3 right-3 z-10">
              <button type="button" onClick={() => setPreviewCollapsed(false)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-800/90 border border-slate-600 text-[11px] text-slate-100 hover:bg-slate-700">
                <span>Show preview</span>
              </button>
            </div>
          )}
          <div className="w-full flex-1 min-h-0 bg-slate-800 rounded-lg border border-slate-700 overflow-hidden flex">
            <div className={chatPaneClass}>
              <ChatInterface
                projectId={projectId}
                project={project}
                approvalType={pendingApproval?.data.type} 
                initialData={pendingApproval?.data.data}
                onApprove={(message) => handleApproval(true, message)}
                onReject={(message, reason) => handleApproval(false, message, reason)}
                pendingApproval={pendingApproval} 
                isReverting={isReverting}
                isExecuting={(() => {
                  const status = (project?.status || '').toLowerCase().trim()
                  const nonExecStatuses = new Set(['', 'initialized', 'cancelled', 'failed', 'completed'])
                  const recent = lastExecEventAtRef.current && (Date.now() - lastExecEventAtRef.current < 8000)
                  return !finalizedRef.current && !!isExecuting && recent && !pendingApproval && !nonExecStatuses.has(status)
                })()}
                onStop={stopOnly}
                // Pass the full events array — LiveActivity's watermark
                // filter handles apply-once semantics. The previous
                // `events.slice(-50)` was a perf window but lost events in
                // bursts larger than 50 (a single render batch can ingest
                // many SSE deltas when the tab was backgrounded), and the
                // watermark made the window unnecessary for correctness.
                recentEvents={allEventsForStreaming}
                allEvents={allEventsForStreaming}
                prefillInput={chatPrefill}
                messageResetNonce={messageResetNonce}
                diagOpen={diagOpen}
                onToggleDiag={() => setDiagOpen(o => !o)}
              />
            </div>
            {showPreview && (
              <div className="hidden lg:flex w-1/2 flex-col bg-slate-900">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 text-[11px] text-slate-300">
                  <span className="font-semibold text-slate-100">Live preview</span>
                  <div className="flex items-center gap-2">
                    <a href={latestDeploymentUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline">Open in new tab</a>
                    <button type="button" onClick={() => setPreviewCollapsed(true)} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-100"><span>Hide</span></button>
                  </div>
                </div>
                <iframe src={latestDeploymentUrl} title="Deployed app preview" className="flex-1 w-full bg-slate-900" />
              </div>
            )}
          </div>
        </div>
      )
    },
    {
      label: 'Snapshots', icon: <FileText className="w-5 h-5" />,
      content: <SnapshotsTab projectId={projectId} onRevertToSnapshot={revertToSnapshot} onStopAndRevertPreviousUserAction={stopAndRevertPreviousUserAction} />
    },
    { label: 'Trace', icon: <Activity className="w-5 h-5" />, content: <TraceTab key={projectId} projectId={projectId} events={events} /> },
    {
      label: 'Tasks', icon: <Activity className="w-5 h-5" />,
      badge: tasksBadge,
      content: <TaskStatusList project={project} projectId={projectId} events={events} />
    },
    {
      label: 'Overview', icon: <Activity className="w-5 h-5" />, badge: project?.status,
      content: <OverviewTab project={project} />
    },
    {
      label: 'Container Logs', icon: <Terminal className="w-5 h-5" />,
      content: project && project.environment_id ? (
        <ContainerLogs projectId={projectId} environmentId={project.environment_id} />
      ) : (
        <div className="bg-slate-800 rounded-lg p-8 text-center">
          <Terminal className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400">No container environment available</p>
        </div>
      )
    },
    {
      label: 'Events',
      icon: <Activity className="w-5 h-5" />,
      badge: eventLogCount > 0 ? eventLogCount : null,
      content: <EventsTab events={events} project={project} projectId={projectId} onStopAndRevertPreviousUserAction={stopAndRevertPreviousUserAction} />
    },
    {
      label: 'Artifacts', icon: <Package className="w-5 h-5" />,
      badge: ((project?.artifacts?.length || 0) + (project?.user_attachments?.length || 0) + archiveRefs.length) || null,
      content: <ArtifactsTab project={project} projectId={projectId} archiveRefs={archiveRefs} />
    },
  ]

  // Status badge
  const getStatusBadge = () => {
    if (!project) return null
    const status = project.status?.toLowerCase()
    if (status === 'completed') return { label: 'Completed', color: 'bg-green-900/30 border-green-600 text-green-100', icon: CheckCircle }
    if (status === 'failed') return { label: 'Failed', color: 'bg-red-900/30 border-red-600 text-red-100', icon: XCircle }
    if (status === 'cancelled') return { label: 'Cancelled', color: 'bg-slate-700/50 border-slate-500 text-slate-300', icon: XCircle }
    if (isExecuting || status === 'running') return { label: 'Running', color: 'bg-blue-900/30 border-blue-600 text-blue-100', icon: Activity }
    return null
  }
  
  const statusBadge = getStatusBadge()
  const showActions = stopped || project?.status === 'cancelled' || project?.status === 'failed' || project?.status === 'completed'
  const activeRunId = project?.current_run_id || project?.run_id
  const currentRunId = currentRunIdOf(activeRunId, runs)
  // Without the Runs panel its trace link would be gone from the page, so the summary carries it.
  const traceUrlWithoutRunsPanel = isRunsPanelHidden(runs, currentRunId)
    ? runs.find((run) => run.run_id === currentRunId)?.trace_url
    : null

  return (
    <div className="min-h-screen bg-slate-900">
      {/* AppFactory-154: ephemeral delegation review gates (floating, event-driven) */}
      {pendingDelegationApprovals?.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4 space-y-2">
          {pendingDelegationApprovals.map((appr) => (
            <DelegationApprovalCard
              key={appr.data?.approval_id}
              approval={appr}
              onApprove={async () => {
                await handleApproval(true, { data: appr.data })
                setPendingDelegationApprovals((prev) => prev.filter((a) => a.data?.approval_id !== appr.data?.approval_id))
              }}
              onReject={async (reason) => {
                await handleApproval(false, { data: appr.data }, reason)
                setPendingDelegationApprovals((prev) => prev.filter((a) => a.data?.approval_id !== appr.data?.approval_id))
              }}
            />
          ))}
        </div>
      )}
      {/* Header */}
      <div className="px-8 py-6 border-b border-slate-800">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-bold text-slate-100">{displayTitle}</h1>
                {statusBadge && (
                  <div className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full border text-[11px] ${statusBadge.color}`}>
                    <statusBadge.icon className="w-3 h-3" />
                    <span>{statusBadge.label}</span>
                  </div>
                )}
                {project && latestDeploymentUrl && project.deploy_status === 'succeeded' && (
                  <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-green-900/30 border border-green-600 text-[11px] text-green-100">
                    <ExternalLink className="w-3 h-3" />
                    <a href={latestDeploymentUrl} target="_blank" rel="noreferrer" className="hover:underline">View App</a>
                  </div>
                )}
              </div>
              <div className="text-slate-500 font-mono text-[10px] mt-0.5">{projectId}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!showActions && (
              <>
                <button onClick={cancelProject} className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white text-xs px-3 py-1.5 rounded transition-colors" title="Cancel project execution">
                  <XCircle className="w-3 h-3" /><span>Cancel</span>
                </button>
                <button onClick={stopOnly} className="inline-flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs px-3 py-1.5 rounded transition-colors" title="Stop execution (can resume later)">
                  <Square className="w-3 h-3" /><span>Stop</span>
                </button>
                <button onClick={stopAndRevertPreviousUserAction} className="inline-flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs px-3 py-1.5 rounded transition-colors" title="Stop and revert to previous state">
                  <RotateCcw className="w-3 h-3" /><span>Stop & Revert</span>
                </button>
              </>
            )}
            {showActions && (
              <button onClick={revertToLastUserMessage} className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors shadow-sm">
                <RotateCcw className="w-4 h-4" /><span>Revert to last user message</span>
              </button>
            )}
            <div className="w-px h-6 bg-slate-700"></div>
            <TopNavLinks />
          </div>
        </div>
        {!projectId.startsWith('creating-') && (
          <ProjectLaunchSummary project={project} viewer={user} traceUrl={traceUrlWithoutRunsPanel} className="mt-2" />
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        <RunsPanel projectId={projectId} activeRunId={activeRunId} runs={runs} setRuns={setRuns} setProject={setProject} showRunsPanel={showRunsPanel} setShowRunsPanel={setShowRunsPanel} setConfirmState={setConfirmState} />

        {authError && (
          <div className="mb-4 p-3 rounded-lg border border-red-700 bg-red-900/20 text-red-200 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium mb-1">Invalid API Key</div>
              <div className="text-xs text-red-300/80">Update your OpenAI API key in Settings to continue.</div>
            </div>
            <a href="/settings" className="inline-flex items-center gap-1.5 bg-red-700 hover:bg-red-600 text-white text-xs px-3 py-1.5 rounded transition-colors flex-shrink-0">
              <Settings className="w-3 h-3" /><span>Settings</span>
            </a>
          </div>
        )}

        {/* Recovery Banner - shows when container/deployment needs recovery */}
        <RecoveryBanner 
          project={project} 
          onRecoveryComplete={() => {
            // Refresh project data after recovery
            apiFetch(`/projects/${projectId}`)
              .then(res => res.json())
              .then(data => setProject(data))
              .catch(err => console.error('Error refreshing project:', err))
          }}
        />

        <TabNavigation tabs={tabs} defaultTab={0} />
        <ConfirmDialog open={confirmState.open} title={confirmState.title} message={confirmState.message} confirmLabel={confirmState.confirmLabel} variant={confirmState.variant} onConfirm={confirmState.onConfirm} onClose={() => setConfirmState(s => ({ ...s, open: false }))} />
      </div>
      <DiagnosticDrawer
        open={diagOpen}
        setOpen={setDiagOpen}
        project={project}
        recentEvents={allEventsForStreaming.slice(-50)}
        allEvents={allEventsForStreaming}
        pendingApproval={pendingApproval}
      />
      {/* DiagnosticDrawer's `recentEvents` slice is fine to keep: that panel
          renders a windowed display, not a state derivation. */}
    </div>
  )
}
