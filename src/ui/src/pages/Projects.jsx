import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, XCircle, Clock, RefreshCw, ExternalLink } from 'lucide-react'
import { apiFetch } from '../utils_api'
import TopNavLinks from '../components/TopNavLinks'
import { ProjectRunFacts } from '../components/ProjectLaunchSummary'
import { projectCountLabel } from '../utils/projectLaunch'

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [total, setTotal] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/projects?limit=100')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setProjects(data.projects || [])
      setTotal(data.total)
    } catch (e) {
      console.error('Failed to load projects:', e)
      setError('Failed to load projects')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const statusIcon = (status) => {
    if (!status) return <Clock className="w-4 h-4 text-slate-400" />
    const s = String(status).toLowerCase()
    if (s.includes('completed')) return <CheckCircle className="w-4 h-4 text-green-400" />
    if (s.includes('failed')) return <XCircle className="w-4 h-4 text-red-400" />
    return <Clock className="w-4 h-4 text-slate-400" />
  }

  const trim = (s, n=80) => {
    if (!s) return ''
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="px-8 py-6 border-b border-slate-800">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold text-slate-100">Projects</h1>
          <TopNavLinks />
        </div>
      </div>
      <div className="max-w-7xl mx-auto p-8">
        <div className="mb-6 flex gap-2">
            <Link
              to="/"
              className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
            >
              + New Project
            </Link>
            <button
              onClick={load}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded"
            >
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
        </div>

        <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
          <div className="p-4 border-b border-slate-700">
            {loading ? (
              <p className="text-slate-400">Loading projects…</p>
            ) : error ? (
              <p className="text-red-400">{error}</p>
            ) : (
              <p className="text-slate-400">{projectCountLabel(projects.length, total)}</p>
            )}
          </div>

          <div className="divide-y divide-slate-700">
            {(!loading && projects.length === 0) && (
              <div className="p-6 text-slate-400">No projects yet. Create one from the Home page.</div>
            )}
            {projects.map((p) => {
              const title = p.title || 'Untitled Project'
              return (
              <div key={p.project_id} className="p-4 flex items-center justify-between">
                <div className="flex items-start gap-3">
                  {statusIcon(p.status)}
                  <div>
                    <div className="text-slate-100 text-sm font-semibold">
                      {title}
                    </div>
                    <div className="text-slate-500 text-xs font-mono mt-0.5">
                      {p.project_id}
                    </div>
                    <div className="text-slate-400 text-sm mt-1">
                      {trim(p.user_prompt)}
                    </div>
                    <ProjectRunFacts project={p} className="mt-1" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 mr-2">{p.status}</span>
                  <Link
                    to={`/monitor/${p.project_id}`}
                    className="inline-flex items-center gap-1 px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded"
                  >
                    <ExternalLink className="w-4 h-4" /> Open
                  </Link>
                </div>
              </div>
            )})}
          </div>
        </div>
      </div>
    </div>
  )
}
