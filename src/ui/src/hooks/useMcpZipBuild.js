import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, formatApiDetail } from '../utils_api'
import { dockerfileSelectionFromAnalyze } from '../utils/mcpZipDockerfileSelection'
import { suggestServerIdFromZipFilename } from '../utils/mcpZipServerId'
import { notify } from '../utils_notify'

const TERMINAL_BUILD_STATUSES = new Set(['ready', 'build_failed', 'smoke_failed'])

export function isZipBuildInFlight(buildStatus) {
  const s = buildStatus?.status
  return s === 'building' || s === 'image_ready' || s === 'smoke_running'
}

export function isCandidateBuildBlocked(candidates, selectedDockerfile) {
  const c = candidates?.find(x => x.relative_path === selectedDockerfile)
  return c?.preflight_status === 'blocked'
}

export function computeWizardStep({
  uploadId,
  candidates,
  buildStatus,
  uploading,
  busy,
  phase,
}) {
  if (buildStatus?.status === 'ready') return 4
  if (
    isZipBuildInFlight(buildStatus)
    || (busy && (phase === 'building' || phase === 'smoke'))
  ) {
    return 3
  }
  if (uploadId && candidates.length > 0) return 3
  if (uploading || (busy && phase === 'analyzing') || (uploadId && !candidates.length)) return 2
  if (uploadId) return 2
  return 1
}

export function computeProgressPercent(wizardStep, buildStatus) {
  if (buildStatus?.status === 'ready') return 100
  if (buildStatus?.status === 'image_ready' || buildStatus?.status === 'smoke_running') return 90
  if (buildStatus?.status === 'build_failed' || buildStatus?.status === 'smoke_failed') return 85
  const map = { 1: 10, 2: 35, 3: 70, 4: 100 }
  return map[wizardStep] ?? 0
}

function buildPayloadValid({ serverId, selectedDockerfile, mode, containerPort, endpointPath }) {
  const sid = serverId.trim()
  const df = selectedDockerfile.trim()
  if (!sid || !df || !mode) return false
  if (mode === 'streamable-http') {
    const port = Number(containerPort)
    if (!Number.isFinite(port) || port < 1 || port > 65535) return false
    if (!(endpointPath || '').trim().startsWith('/')) return false
  }
  return true
}

export { suggestServerIdFromZipFilename } from '../utils/mcpZipServerId'

export default function useMcpZipBuild({ onWizardReset, onSyncDiscoverFromZip } = {}) {
  const [zipFile, setZipFile] = useState(null)
  const [serverId, setServerId] = useState('')
  const [containerPort, setContainerPort] = useState('')
  const [endpointPath, setEndpointPath] = useState('/mcp')
  const [mode, setMode] = useState('')
  const [uploadId, setUploadId] = useState('')
  const [phase, setPhase] = useState('idle')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [selectedDockerfile, setSelectedDockerfileRaw] = useState('')
  const [previewImageTag, setPreviewImageTag] = useState('')
  const [jobId, setJobId] = useState('')
  const [buildStatus, setBuildStatus] = useState(null)
  const [buildLog, setBuildLog] = useState('')
  const [builtImages, setBuiltImages] = useState([])
  const [imagesLoading, setImagesLoading] = useState(false)
  const [hostPort, setHostPort] = useState(null)
  const [archiveWarnings, setArchiveWarnings] = useState([])
  const pollRef = useRef(null)
  const pollStoppedRef = useRef(false)
  const uploadGenRef = useRef(0)
  const onWizardResetRef = useRef(onWizardReset)
  const onSyncDiscoverRef = useRef(onSyncDiscoverFromZip)
  onWizardResetRef.current = onWizardReset
  onSyncDiscoverRef.current = onSyncDiscoverFromZip

  const zipDiscoverPayload = useCallback(
    (overrides = {}) => {
      const resolvedMode = overrides.mode || mode || 'streamable-http'
      const imageTag = overrides.image || buildStatus?.image_tag || previewImageTag || ''
      return {
        server_id: String(overrides.server_id ?? serverId).trim(),
        mode: resolvedMode,
        image: imageTag,
        container_port: resolvedMode === 'stdio'
          ? undefined
          : Number(overrides.container_port ?? containerPort) || undefined,
        host_port: overrides.host_port ?? hostPort ?? buildStatus?.host_port ?? null,
        path: String((overrides.path ?? endpointPath) || '/mcp').trim(),
        runtime_scope: 'tenant',
        docker_cmd_args: undefined,
      }
    },
    [buildStatus, previewImageTag, serverId, mode, containerPort, hostPort, endpointPath],
  )

  const setSelectedDockerfile = useCallback((relativePath) => {
    setSelectedDockerfileRaw(relativePath)
    setError(null)
  }, [])

  const clearPoll = useCallback(() => {
    pollStoppedRef.current = true
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => () => clearPoll(), [clearPoll])

  const wizardStep = useMemo(
    () => computeWizardStep({ uploadId, candidates, buildStatus, uploading, busy, phase }),
    [uploadId, candidates, buildStatus, uploading, busy, phase],
  )

  const progressPercent = useMemo(
    () => computeProgressPercent(wizardStep, buildStatus),
    [wizardStep, buildStatus],
  )

  const formReady = useMemo(
    () => buildPayloadValid({
      serverId,
      selectedDockerfile,
      mode,
      containerPort,
      endpointPath,
    }),
    [serverId, selectedDockerfile, mode, containerPort, endpointPath],
  )

  const fetchBuiltImages = useCallback(async () => {
    setImagesLoading(true)
    try {
      const res = await apiFetch('/configurations/mcp-tools/mcp-built-images/')
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || `Failed to list images (${res.status})`)
      }
      const data = await res.json()
      setBuiltImages(Array.isArray(data.images) ? data.images : [])
    } catch (err) {
      notify({ title: 'Built images', message: err.message, variant: 'error', ttl: 6000 })
    } finally {
      setImagesLoading(false)
    }
  }, [])

  const pollBuildStatus = useCallback(async (uid, jid, sid) => {
    const q = new URLSearchParams({ job_id: jid })
    if (sid) q.set('server_id', sid)
    const res = await apiFetch(
      `/configurations/mcp-tools/mcp-packages/${encodeURIComponent(uid)}/build-status?${q}`,
    )
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      throw new Error(formatApiDetail(e.detail) || 'Build status failed')
    }
    return res.json()
  }, [])

  const startPolling = useCallback((uid, jid, sid) => {
    clearPoll()
    pollStoppedRef.current = false
    const pollGen = uploadGenRef.current

    const scheduleNext = () => {
      if (pollStoppedRef.current || pollGen !== uploadGenRef.current) return
      pollRef.current = setTimeout(tick, 2000)
    }

    const tick = async () => {
      if (pollStoppedRef.current || pollGen !== uploadGenRef.current) {
        clearPoll()
        return
      }
      try {
        const st = await pollBuildStatus(uid, jid, sid)
        if (pollStoppedRef.current || pollGen !== uploadGenRef.current) return
        setBuildStatus(st)
        setBuildLog(st.log_tail || '')
        setPhase(st.status || 'building')
        if (st.host_port != null) setHostPort(Number(st.host_port))
        if (TERMINAL_BUILD_STATUSES.has(st.status)) {
          clearPoll()
          setBusy(false)
          setJobId('')
          if (st.status === 'ready') {
            onSyncDiscoverRef.current?.(
              zipDiscoverPayload({
                image: st.image_tag,
                host_port: st.host_port,
              }),
              st.image_tag,
            )
            const tools = st.discover_tool_count ?? 0
            notify({
              title: 'MCP image ready',
              message: st.image_tag
                ? `${st.image_tag} (${tools} tools)`
                : 'Build and smoke discover completed',
              variant: 'success',
              ttl: 6000,
            })
            fetchBuiltImages()
          } else {
            notify({
              title: 'MCP build failed',
              message: st.error || st.status,
              variant: 'error',
              ttl: 8000,
            })
          }
          return
        }
        scheduleNext()
      } catch (err) {
        if (pollGen === uploadGenRef.current) {
          clearPoll()
          setBusy(false)
          setJobId('')
          setError(err.message)
        }
      }
    }
    tick()
  }, [clearPoll, fetchBuiltImages, pollBuildStatus, zipDiscoverPayload])

  const analyzeZip = useCallback(async (uid) => {
    const uidUse = uid || uploadId
    if (!uidUse) {
      setError('Upload the ZIP first, then scan for Dockerfiles')
      return false
    }
    const gen = uploadGenRef.current
    setBusy(true)
    setError(null)
    setPhase('analyzing')
    try {
      const res = await apiFetch(
        `/configurations/mcp-tools/mcp-packages/${encodeURIComponent(uidUse)}/analyze`,
        { method: 'POST' },
      )
      if (gen !== uploadGenRef.current) return false
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        const detail = formatApiDetail(e.detail) || `Analyze failed (${res.status})`
        if (res.status === 403) {
          throw new Error(`${detail} (MCP ZIP import requires tenant_admin)`)
        }
        throw new Error(detail)
      }
      const data = await res.json()
      if (gen !== uploadGenRef.current) return false
      if (data.server_id) {
        setServerId(data.server_id)
        onSyncDiscoverRef.current?.({ server_id: data.server_id, mode: mode || '', image: previewImageTag || '' })
      }
      const list = data.candidates || []
      setCandidates(list)
      setArchiveWarnings(data.archive_warnings || [])
      setPreviewImageTag(data.autofill?.image || '')
      const selection = dockerfileSelectionFromAnalyze(list)
      setSelectedDockerfileRaw(selection.selectedPath)
      if (selection.containerPort != null) {
        setContainerPort(String(selection.containerPort))
      }
      setPhase('analyzed')
      const count = list.length
      notify({
        title: 'Dockerfile scan complete',
        message: selection.autoSelected
          ? `Auto-selected ${selection.selectedPath} (only Dockerfile in archive). Set mode and build.`
          : `${count} candidate(s) — pick one and set mode/port manually`,
        variant: 'success',
        ttl: 5000,
      })
      return true
    } catch (err) {
      if (gen === uploadGenRef.current) {
        setError(err.message)
        setPhase('uploaded')
        notify({ title: 'Analyze failed', message: err.message, variant: 'error', ttl: 7000 })
      }
      return false
    } finally {
      if (gen === uploadGenRef.current) {
        setBusy(false)
      }
    }
  }, [uploadId, mode, previewImageTag])

  const uploadZip = useCallback(async (fileOverride, { autoScan = false, serverIdOverride = '' } = {}) => {
    const file = fileOverride || zipFile
    const sid = String(serverIdOverride || serverId).trim()
    if (!sid) {
      setError('Server ID is required before upload')
      return false
    }
    if (!file) {
      setError('Choose a .zip file first')
      return false
    }
    const gen = ++uploadGenRef.current
    setUploading(true)
    setBusy(true)
    setError(null)
    clearPoll()
    setCandidates([])
    setArchiveWarnings([])
    setSelectedDockerfileRaw('')
    setHostPort(null)
    setPreviewImageTag('')
    setBuildStatus(null)
    setBuildLog('')
    setJobId('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const q = `?server_id=${encodeURIComponent(sid)}`
      const res = await apiFetch(`/configurations/mcp-tools/mcp-packages/upload${q}`, {
        method: 'POST',
        body: fd,
      })
      if (gen !== uploadGenRef.current) return false
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        const detail = formatApiDetail(e.detail) || `Upload failed (${res.status})`
        if (res.status === 403) {
          throw new Error(`${detail} (MCP ZIP import requires tenant_admin)`)
        }
        throw new Error(detail)
      }
      const data = await res.json()
      setZipFile(file)
      const resolvedSid = data.server_id || sid
      setUploadId(data.upload_id)
      setServerId(resolvedSid)
      onSyncDiscoverRef.current?.({ server_id: resolvedSid, mode: mode || '', image: previewImageTag || '' })
      setPhase('uploaded')
      notify({
        title: 'ZIP uploaded',
        message: autoScan ? 'Scanning for Dockerfiles…' : 'Click Scan Dockerfiles or wait for auto-scan',
        variant: 'success',
        ttl: 3500,
      })
      if (autoScan && data.upload_id) {
        await analyzeZip(data.upload_id)
      }
      return true
    } catch (err) {
      if (gen === uploadGenRef.current) {
        setError(err.message)
        setPhase('idle')
        notify({ title: 'Upload failed', message: err.message, variant: 'error', ttl: 7000 })
      }
      return false
    } finally {
      if (gen === uploadGenRef.current) {
        setUploading(false)
        setBusy(false)
      }
    }
  }, [zipFile, serverId, clearPoll])

  const handleFileSelected = useCallback(async (file) => {
    if (!file) return
    if (isZipBuildInFlight(buildStatus)) {
      setError('Cannot replace ZIP while build or smoke is in progress')
      return
    }
    if (!String(file.name || '').toLowerCase().endsWith('.zip')) {
      setError('Only .zip archives are supported')
      return
    }
    setZipFile(file)
    setError(null)
    const sid = suggestServerIdFromZipFilename(file.name)
    setServerId(sid)
    onSyncDiscoverRef.current?.({ server_id: sid, mode: '', image: '' })
    await uploadZip(file, { autoScan: true, serverIdOverride: sid })
  }, [uploadZip, buildStatus])

  const discoverDockerfile = useCallback(() => {
    if (!uploadId) {
      setError('Upload the ZIP first (set Server ID, then choose the .zip file)')
      return Promise.resolve(false)
    }
    return analyzeZip()
  }, [analyzeZip, uploadId])

  const startBuild = useCallback(async () => {
    if (busy || pollRef.current) {
      setError('A build is already in progress for this package')
      return
    }
    if (isZipBuildInFlight(buildStatus)) {
      setError('A build or smoke test is still running for this package')
      return
    }
    if (!buildPayloadValid({
      serverId,
      selectedDockerfile,
      mode,
      containerPort,
      endpointPath,
    })) {
      setError('Fill Server ID, pick a Dockerfile, mode, and (for HTTP) port + path')
      return
    }
    if (isCandidateBuildBlocked(candidates, selectedDockerfile)) {
      setError('Selected Dockerfile is blocked by preflight')
      return
    }
    const gen = uploadGenRef.current
    setBusy(true)
    setError(null)
    setBuildLog('')
    onSyncDiscoverRef.current?.(zipDiscoverPayload())
    try {
      const body = {
        server_id: serverId.trim(),
        dockerfile_relative_path: selectedDockerfile,
        mode,
        endpoint_path: (endpointPath || '/mcp').trim(),
      }
      if (mode === 'streamable-http') {
        body.container_port = Number(containerPort)
      }
      const st = buildStatus?.status
      if (st === 'ready' || st === 'image_ready' || st === 'smoke_running') {
        body.force_rebuild = true
      }
      const res = await apiFetch(
        `/configurations/mcp-tools/mcp-packages/${encodeURIComponent(uploadId)}/build`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (gen !== uploadGenRef.current) return
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        const detail = formatApiDetail(e.detail) || `Build failed (${res.status})`
        if (res.status === 409) {
          setError(detail)
          notify({ title: 'Build already running', message: detail, variant: 'warning', ttl: 6000 })
          return
        }
        throw new Error(detail)
      }
      const data = await res.json()
      if (gen !== uploadGenRef.current) return
      setJobId(data.job_id)
      setPhase('building')
      startPolling(uploadId, data.job_id, serverId.trim())
      notify({
        title: 'Build started',
        message: data.image_tag || '',
        variant: 'info',
        ttl: 4000,
      })
    } catch (err) {
      if (gen !== uploadGenRef.current) return
      if (!pollRef.current) {
        setBusy(false)
      }
      setError(err.message)
      notify({ title: 'Build failed', message: err.message, variant: 'error', ttl: 7000 })
    }
  }, [
    busy,
    uploadId,
    serverId,
    selectedDockerfile,
    containerPort,
    endpointPath,
    mode,
    buildStatus,
    candidates,
    startPolling,
    zipDiscoverPayload,
  ])

  const deleteBuiltImage = useCallback(async (docId) => {
    if (!docId) return
    setBusy(true)
    try {
      const res = await apiFetch(
        `/configurations/mcp-tools/mcp-built-images/${encodeURIComponent(docId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok && res.status !== 204) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || `Delete failed (${res.status})`)
      }
      await fetchBuiltImages()
      notify({ title: 'Image deleted', variant: 'success', ttl: 3000 })
    } catch (err) {
      notify({ title: 'Delete failed', message: err.message, variant: 'error', ttl: 7000 })
      throw err
    } finally {
      setBusy(false)
    }
  }, [fetchBuiltImages])

  const copyBuildLog = useCallback(async () => {
    const text = buildLog || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      notify({ title: 'Log copied', variant: 'success', ttl: 2000 })
    } catch {
      notify({ title: 'Copy failed', message: 'Clipboard not available', variant: 'warning', ttl: 4000 })
    }
  }, [buildLog])

  const resetWizard = useCallback(() => {
    uploadGenRef.current += 1
    onWizardResetRef.current?.()
    clearPoll()
    setZipFile(null)
    setServerId('')
    setContainerPort('')
    setEndpointPath('/mcp')
    setMode('')
    setUploadId('')
    setPhase('idle')
    setBusy(false)
    setUploading(false)
    setError(null)
    setCandidates([])
    setArchiveWarnings([])
    setSelectedDockerfileRaw('')
    setHostPort(null)
    setPreviewImageTag('')
    setJobId('')
    setBuildStatus(null)
    setBuildLog('')
  }, [clearPoll])

  const getConnectPayload = useCallback(
    () => zipDiscoverPayload(),
    [zipDiscoverPayload],
  )

  return {
    zipFile,
    serverId,
    setServerId,
    containerPort,
    setContainerPort,
    endpointPath,
    setEndpointPath,
    mode,
    setMode,
    uploadId,
    phase,
    statusHint: (() => {
      if (busy && phase === 'analyzing') return 'Scanning archive for Dockerfiles…'
      if (uploading) return 'Uploading and extracting ZIP on API host…'
      if (zipFile && !uploadId) return 'ZIP selected — uploading…'
      if (uploadId && !candidates.length && phase === 'uploaded') {
        return 'Uploaded. Click Scan Dockerfiles if the list is still empty.'
      }
      return ''
    })(),
    busy,
    uploading,
    error,
    setError,
    candidates,
    selectedDockerfile,
    setSelectedDockerfile,
    previewImageTag,
    jobId,
    buildStatus,
    buildLog,
    hostPort,
    archiveWarnings,
    formReady,
    isCandidateBuildBlocked: () => isCandidateBuildBlocked(candidates, selectedDockerfile),
    builtImages,
    imagesLoading,
    wizardStep,
    progressPercent,
    handleFileSelected,
    uploadZip,
    discoverDockerfile,
    analyzeZip,
    startBuild,
    fetchBuiltImages,
    deleteBuiltImage,
    copyBuildLog,
    resetWizard,
    getConnectPayload,
  }
}
