import { useState, useEffect, useRef } from 'react'
import { apiFetch, apiUrl } from '../utils_api'
import { Terminal, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'

export default function ContainerLogs({ projectId, environmentId }) {
  const [logs, setLogs] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isPageVisible, setIsPageVisible] = useState(typeof document !== 'undefined' ? !document.hidden : true)
  const logsEndRef = useRef(null)
  const refreshIntervalRef = useRef(null)

  const fetchLogs = async () => {
    if (!projectId) {
      console.log('❌ ContainerLogs: No projectId')
      return
    }
    
    console.log(`📋 ContainerLogs: Fetching logs for projectId=${projectId}, environmentId=${environmentId}`)
    
    setLoading(true)
    setError(null)

    try {
      // Include environment_id as query parameter if available
      const path = environmentId 
        ? `/projects/${projectId}/logs?environment_id=${environmentId}`
        : `/projects/${projectId}/logs`
      
      console.log(`🌐 ContainerLogs: Fetching ${apiUrl(path)}`)
      
      const response = await apiFetch(path)
      const data = await response.json()

      console.log(`📦 ContainerLogs: Response status=${response.status}, data=`, data)

      if (response.ok) {
        setLogs(data.logs || '')
        if (data.error) {
          setError(data.error)
        }
        console.log(`✅ ContainerLogs: Logs updated, length=${data.logs?.length || 0}`)
      } else {
        const errorMsg = data.error || 'Failed to fetch logs'
        setError(errorMsg)
        console.error(`❌ ContainerLogs: Error - ${errorMsg}`)
      }
    } catch (err) {
      const errorMsg = err.message || 'Network error'
      setError(errorMsg)
      console.error(`❌ ContainerLogs: Exception - ${errorMsg}`, err)
    } finally {
      setLoading(false)
    }
  }

  // Track page/tab visibility to avoid background polling
  useEffect(() => {
    const onVis = () => {
      const vis = !document.hidden
      setIsPageVisible(vis)
      if (vis && autoRefresh && !isCollapsed) {
        // Trigger an immediate refresh when regaining visibility
        fetchLogs()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [autoRefresh, isCollapsed])

  useEffect(() => {
    // Clear any existing interval before setting a new one
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current)
      refreshIntervalRef.current = null
    }

    // Initial fetch if we are allowed to poll now
    if (autoRefresh && isPageVisible && !isCollapsed && environmentId) {
      fetchLogs()
      refreshIntervalRef.current = setInterval(fetchLogs, 3000) // Refresh every 3 seconds
    }

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current)
        refreshIntervalRef.current = null
      }
    }
  }, [projectId, environmentId, autoRefresh, isPageVisible, isCollapsed])

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (!isCollapsed && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, isCollapsed])

  const toggleAutoRefresh = () => {
    setAutoRefresh(!autoRefresh)
    if (!autoRefresh) {
      // If turning on, fetch immediately
      fetchLogs()
    }
  }

  if (!environmentId) {
    return null
  }

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-blue-400" />
          <h3 className="text-lg font-semibold text-slate-100">Container Logs</h3>
          <span className="text-xs text-slate-400 font-mono bg-slate-700 px-2 py-1 rounded">
            {environmentId}
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAutoRefresh}
            className={`flex items-center gap-1 px-3 py-1 rounded text-sm ${
              autoRefresh 
                ? 'bg-green-600 hover:bg-green-700 text-white' 
                : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            Auto-refresh {autoRefresh ? 'ON' : 'OFF'}
          </button>
          
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1 rounded text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1 rounded text-sm"
          >
            {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Logs Content */}
      {!isCollapsed && (
        <div className="p-4">
          {error && (
            <div className="bg-red-900/20 border border-red-700 rounded p-3 mb-3">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          <div className="bg-slate-900 rounded-lg p-4 max-h-96 overflow-y-auto font-mono text-xs">
            {logs ? (
              <pre className="text-slate-300 whitespace-pre-wrap">{logs}</pre>
            ) : (
              <p className="text-slate-500 text-center py-4">
                {loading ? 'Loading logs...' : 'No logs available'}
              </p>
            )}
            <div ref={logsEndRef} />
          </div>

          <div className="mt-2 text-xs text-slate-500 text-right">
            Tip: Run <code className="bg-slate-700 px-1 rounded">cu log {environmentId}</code> on host to view logs directly
          </div>
        </div>
      )}
    </div>
  )
}
