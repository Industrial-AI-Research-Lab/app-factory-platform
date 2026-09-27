import { useEffect, useState, useCallback } from 'react'
import { Download, Upload, Play, AlertTriangle, Check } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import { apiFetch, formatApiDetail } from '../utils_api'
import useAuth from '../hooks/useAuth'

const ACTION_STYLE = {
  insert: 'bg-emerald-600 text-white',
  update: 'bg-blue-600 text-white',
  skip: 'bg-slate-600 text-white',
  error: 'bg-red-600 text-white',
}

const KINDS = ['agents', 'workflows', 'tools', 'run_configurations', 'a2a_servers']

function summaryRowOk(counts) {
  return counts && (counts.total || 0) > 0
}

export default function ConfigBundle() {
  const { user } = useAuth()
  const isRoot = user?.role === 'root'
  const ownTenantId = user?.tenant_id || ''

  const [tenants, setTenants] = useState([])
  const [tenantsLoading, setTenantsLoading] = useState(true)
  const [tenantsError, setTenantsError] = useState(null)

  // Export state
  const [exportTenantId, setExportTenantId] = useState('')
  const [exporting, setExporting] = useState(false)

  // Import state
  const [bundleFile, setBundleFile] = useState(null)
  const [bundleData, setBundleData] = useState(null)
  const [importTenantId, setImportTenantId] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState(null)
  const [error, setError] = useState(null)

  const fetchTenants = useCallback(async () => {
    if (!isRoot) {
      setTenantsLoading(false)
      return
    }
    setTenantsLoading(true)
    setTenantsError(null)
    try {
      const res = await apiFetch('/tenants/')
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Failed to fetch tenants')
      }
      setTenants(await res.json() || [])
    } catch (err) {
      setTenantsError(err.message)
    } finally {
      setTenantsLoading(false)
    }
  }, [isRoot])

  useEffect(() => {
    if (!isRoot && ownTenantId) {
      setExportTenantId(ownTenantId)
      setImportTenantId(ownTenantId)
    }
    fetchTenants()
  }, [fetchTenants, isRoot, ownTenantId])

  const handleExport = async () => {
    if (!exportTenantId) return
    setExporting(true)
    setError(null)
    try {
      const res = await apiFetch(
        `/admin/config-bundle/export?tenant_id=${encodeURIComponent(exportTenantId)}`
      )
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Export failed')
      }
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${exportTenantId}-bundle.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    } finally {
      setExporting(false)
    }
  }

  const handleFileSelect = async (file) => {
    setBundleFile(file)
    setBundleData(null)
    setPreview(null)
    setApplyResult(null)
    setError(null)
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Bundle file is not a JSON object')
      }
      setBundleData(parsed)
    } catch (err) {
      setError(`Failed to parse bundle: ${err.message}`)
      setBundleFile(null)
    }
  }

  const handlePreview = async () => {
    if (!bundleData || !importTenantId) return
    setPreviewing(true)
    setError(null)
    setPreview(null)
    setApplyResult(null)
    try {
      const res = await apiFetch('/admin/config-bundle/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundle: bundleData,
          target_tenant_id: importTenantId,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Preview failed')
      }
      setPreview(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setPreviewing(false)
    }
  }

  const handleApply = async () => {
    if (!bundleData || !importTenantId || !preview) return
    const summary = preview.summary || {}
    const writeCount = Object.values(summary).reduce(
      (acc, s) => acc + (s.insert || 0) + (s.update || 0), 0
    )
    if (!confirm(
      `Apply bundle to tenant "${importTenantId}"? ` +
      `${writeCount} item(s) will be written.`
    )) return
    setApplying(true)
    setError(null)
    setApplyResult(null)
    try {
      const res = await apiFetch('/admin/config-bundle/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundle: bundleData,
          target_tenant_id: importTenantId,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Apply failed')
      }
      setApplyResult(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setApplying(false)
    }
  }

  const renderResult = (result, label) => {
    if (!result) return null
    const items = result.items || {}
    const summary = result.summary || {}
    return (
      <div className="mt-6 space-y-4">
        <h3 className="text-lg font-semibold text-slate-100">{label} → {result.target_tenant_id}</h3>
        {KINDS.map(kind => {
          if (!summaryRowOk(summary[kind])) return null
          const counts = summary[kind]
          return (
            <div key={kind} className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
              <div className="px-4 py-2 bg-slate-700/50 text-sm text-slate-200">
                <span className="font-medium">{kind}</span>
                <span className="ml-3 text-slate-400">
                  total={counts.total} · insert={counts.insert} · update={counts.update} · skip={counts.skip} · error={counts.error}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-800/80 text-slate-400 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left w-24">Action</th>
                    <th className="px-3 py-2 text-left">_id</th>
                    <th className="px-3 py-2 text-left">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {(items[kind] || []).map((it, i) => (
                    <tr key={i} className="hover:bg-slate-700/30">
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${ACTION_STYLE[it.action] || 'bg-slate-500 text-white'}`}>
                          {(it.action || 'unknown').toUpperCase()}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-200">{it._id}</td>
                      <td className="px-3 py-2 text-slate-300">
                        {it.action === 'error' && (
                          <span className="text-red-400">{it.error}</span>
                        )}
                        {it.action === 'update' && it.diff && it.diff.length > 0 && (
                          <details className="cursor-pointer">
                            <summary className="text-slate-300 select-none">{it.diff.length} field(s) changed</summary>
                            <ul className="mt-1 ml-4 text-xs text-slate-400 list-disc list-inside">
                              {it.diff.map((d, j) => (
                                <li key={j}><code className="font-mono">{d.field}</code></li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {it.action === 'update' && (!it.diff || it.diff.length === 0) && (
                          <span className="text-slate-500 italic">(no field changes, audit refresh only)</span>
                        )}
                        {it.status === 'success' && (
                          <span className="inline-flex items-center gap-1 text-emerald-400 ml-2">
                            <Check className="w-3 h-3" /> applied
                          </span>
                        )}
                        {it.ref_notes && it.ref_notes.length > 0 && (
                          <ul className="mt-1 ml-4 text-xs text-amber-400 list-disc list-inside">
                            {it.ref_notes.map((n, j) => (
                              <li key={j}>{n}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="px-8 py-6 border-b border-slate-800">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-slate-100">Configuration Bundle</h1>
          <TopNavLinks />
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6">
        <p className="text-slate-400 mb-6">
          Export tenant configurations to a JSON bundle, or import a bundle into a target tenant.
          Bifrost-managed MCP tools are excluded from V1 bundles.
        </p>

        {tenantsError && (
          <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded text-red-200 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{tenantsError}</span>
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded text-red-200 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Import section */}
        <section className="bg-slate-800 border border-slate-700 rounded-lg p-5 mb-6">
          <h2 className="text-lg font-semibold text-slate-100 mb-3 flex items-center gap-2">
            <Upload className="w-4 h-4" /> Import bundle
          </h2>

          <div className="space-y-3">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Bundle file</label>
              <input
                type="file"
                accept=".json,application/json"
                onChange={e => handleFileSelect(e.target.files?.[0] || null)}
                className="text-sm text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:bg-slate-700 file:text-slate-200 file:border-0 file:rounded hover:file:bg-slate-600"
              />
              {bundleFile && (
                <div className="mt-1 text-xs text-slate-500">
                  {bundleFile.name} · {Math.round(bundleFile.size / 1024)} KB
                  {bundleData?.exported_from && ` · exported from ${bundleData.exported_from}`}
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-1">Target tenant</label>
              {isRoot ? (
                <select
                  value={importTenantId}
                  onChange={e => setImportTenantId(e.target.value)}
                  disabled={tenantsLoading}
                  className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">— select tenant —</option>
                  {tenants.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
                  ))}
                </select>
              ) : (
                <div className="bg-slate-700/60 border border-slate-600 rounded px-3 py-2 text-slate-300 text-sm">
                  <code className="font-mono text-slate-100">{ownTenantId}</code>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handlePreview}
                disabled={!bundleData || !importTenantId || previewing}
                className="inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-slate-200 text-sm font-medium px-4 py-2 rounded transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                {previewing ? 'Previewing…' : 'Preview (dry-run)'}
              </button>
              <button
                onClick={handleApply}
                disabled={!preview || applying}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
              >
                {applying ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>

          {renderResult(preview, 'Preview')}
          {renderResult(applyResult, 'Apply result')}
        </section>

        {/* Export section */}
        <section className="bg-slate-800 border border-slate-700 rounded-lg p-5">
          <h2 className="text-lg font-semibold text-slate-100 mb-3 flex items-center gap-2">
            <Download className="w-4 h-4" /> Export tenant
          </h2>
          <div className="flex gap-3 items-center">
            {isRoot ? (
              <select
                value={exportTenantId}
                onChange={e => setExportTenantId(e.target.value)}
                disabled={tenantsLoading || exporting}
                className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— select tenant —</option>
                {tenants.map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
                ))}
              </select>
            ) : (
              <div className="bg-slate-700/60 border border-slate-600 rounded px-3 py-2 text-slate-300 text-sm">
                Tenant: <code className="font-mono text-slate-100">{ownTenantId}</code>
              </div>
            )}
            <button
              onClick={handleExport}
              disabled={!exportTenantId || exporting}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:text-slate-400 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
            >
              {exporting ? 'Exporting…' : 'Download bundle'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
