import { useState } from 'react'
import { Upload, AlertTriangle, X } from 'lucide-react'
import { apiFetch, formatApiDetail } from '../utils_api'
import useAuth from '../hooks/useAuth'

const ALL_KINDS = ['agents', 'workflows', 'tools', 'run_configurations', 'a2a_servers']

const KIND_LABEL = {
  agents: 'Agent',
  workflows: 'Workflow',
  tools: 'Tool',
  run_configurations: 'Run Configuration',
  a2a_servers: 'A2A Server',
}

const ACTION_STYLE = {
  insert: 'bg-emerald-600 text-white',
  update: 'bg-blue-600 text-white',
  skip: 'bg-slate-600 text-white',
  error: 'bg-red-600 text-white',
}

// Pure parser. Accepts three shapes and always returns the slice
// for `kind` plus a summary of what else was in the input.
//   1. Full bundle:  { items: { agents: [...], workflows: [...], ... } }
//   2. Array:        [ {...}, {...} ]
//   3. Single obj:   { _id, name, ... }
// Throws on non-object input.
export function parseImportInput(raw, kind) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Input is not a JSON object')
  }

  if (!Array.isArray(raw) && raw.items && typeof raw.items === 'object') {
    const items = Array.isArray(raw.items[kind]) ? raw.items[kind] : []
    const ignored = {}
    for (const k of ALL_KINDS) {
      if (k === kind) continue
      const arr = raw.items[k]
      if (Array.isArray(arr) && arr.length > 0) {
        ignored[k] = arr.length
      }
    }
    return { items, ignored }
  }

  if (Array.isArray(raw)) {
    return { items: raw, ignored: {} }
  }

  return { items: [raw], ignored: {} }
}

function buildMiniBundle(items, kind) {
  const bundle = { items: {} }
  for (const k of ALL_KINDS) {
    bundle.items[k] = k === kind ? items : []
  }
  return bundle
}

export default function InlineImportJson({ kind, onImported }) {
  const { user } = useAuth()
  const tenantId = user?.tenant_id || ''
  const kindLabel = KIND_LABEL[kind] || kind

  const [open, setOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [parsed, setParsed] = useState(null)
  const [parseError, setParseError] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState(null)
  const [error, setError] = useState(null)

  const reset = () => {
    setRawText('')
    setParsed(null)
    setParseError(null)
    setPreview(null)
    setApplyResult(null)
    setError(null)
  }

  const close = () => {
    setOpen(false)
    reset()
  }

  const doParse = (text) => {
    setParsed(null)
    setParseError(null)
    setPreview(null)
    setApplyResult(null)
    try {
      const obj = JSON.parse(text)
      const { items, ignored } = parseImportInput(obj, kind)
      if (items.length === 0) {
        const otherKinds = Object.keys(ignored)
        if (otherKinds.length > 0) {
          const list = otherKinds
            .map(k => `${ignored[k]} ${KIND_LABEL[k] || k}${ignored[k] === 1 ? '' : 's'}`)
            .join(', ')
          setParseError(
            `No ${kind} in the input. Found ${list} — open the matching page to import those.`,
          )
        } else {
          setParseError(`No ${kind} found in the input`)
        }
        return
      }
      setParsed({ items, ignored })
    } catch (e) {
      setParseError(`Invalid JSON: ${e.message}`)
    }
  }

  const handleFile = async (file) => {
    if (!file) return
    try {
      const text = await file.text()
      setRawText(text)
      doParse(text)
    } catch (e) {
      setParseError(`Failed to read file: ${e.message}`)
    }
  }

  const doPreview = async () => {
    if (!parsed || !tenantId) return
    setPreviewing(true)
    setError(null)
    setPreview(null)
    try {
      const bundle = buildMiniBundle(parsed.items, kind)
      const res = await apiFetch('/admin/config-bundle/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle, target_tenant_id: tenantId }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Preview failed')
      }
      setPreview(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  const doApply = async () => {
    if (!parsed || !preview || !tenantId) return
    const summary = preview.summary?.[kind] || {}
    const writeCount = (summary.insert || 0) + (summary.update || 0)
    if (!confirm(`Apply ${writeCount} ${kindLabel}(s) to tenant "${tenantId}"?`)) return
    setApplying(true)
    setError(null)
    try {
      const bundle = buildMiniBundle(parsed.items, kind)
      const res = await apiFetch('/admin/config-bundle/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle, target_tenant_id: tenantId }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(formatApiDetail(e.detail) || 'Apply failed')
      }
      setApplyResult(await res.json())
      if (onImported) onImported()
    } catch (e) {
      setError(e.message)
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1"
        title={`Import ${kindLabel}s from JSON`}
      >
        <Upload className="w-3.5 h-3.5" /> Import JSON
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-10 pb-10 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-3xl mx-4">
            <div className="px-5 py-3 border-b border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-100">
                Import {kindLabel}s from JSON
              </h2>
              <button onClick={close} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-400">
                Paste JSON below or upload a file. Accepts a full Config Bundle
                (only the <code className="text-slate-200">{kind}</code> portion
                will be imported), an array of {kindLabel}s, or a single {kindLabel} object.
                Target tenant: <code className="text-slate-200">{tenantId}</code>.
              </p>

              <input
                type="file"
                accept="application/json,.json"
                onChange={e => handleFile(e.target.files?.[0] || null)}
                className="text-sm text-slate-300 file:mr-2 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-slate-700 file:text-slate-200 file:hover:bg-slate-600"
              />

              <textarea
                value={rawText}
                onChange={e => setRawText(e.target.value)}
                onBlur={() => rawText && doParse(rawText)}
                placeholder='{"items": {"agents": [...]}} or [...] or {...}'
                rows={8}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {rawText && !parsed && !parseError && (
                <button onClick={() => doParse(rawText)} className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded">
                  Parse
                </button>
              )}

              {parseError && (
                <div className="p-3 bg-red-900/40 border border-red-700 rounded text-red-200 text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{parseError}</span>
                </div>
              )}

              {parsed && (
                <div className="bg-slate-800 border border-slate-700 rounded p-3 space-y-2">
                  <div className="text-sm text-slate-200">
                    Ready to import <strong>{parsed.items.length}</strong> {kindLabel}{parsed.items.length === 1 ? '' : 's'}.
                  </div>
                  {Object.keys(parsed.ignored).length > 0 && (
                    <div className="p-2 bg-yellow-900/30 border border-yellow-700 rounded text-yellow-200 text-xs flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <div>
                        <div className="font-medium mb-1">Other kinds in input — ignored on this page:</div>
                        <ul className="list-disc list-inside">
                          {Object.entries(parsed.ignored).map(([k, n]) => (
                            <li key={k}>{n} {KIND_LABEL[k] || k}{n === 1 ? '' : 's'} — use the {KIND_LABEL[k] || k}s page</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={doPreview}
                      disabled={previewing}
                      className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded"
                    >
                      {previewing ? 'Previewing…' : 'Preview changes'}
                    </button>
                    {preview && !applyResult && (
                      <button
                        onClick={doApply}
                        disabled={applying}
                        className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded"
                      >
                        {applying ? 'Applying…' : 'Apply'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-900/40 border border-red-700 rounded text-red-200 text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {preview && <DiffResult result={preview} kind={kind} label="Preview" />}
              {applyResult && <DiffResult result={applyResult} kind={kind} label="Applied" />}
            </div>

            <div className="px-5 py-3 border-t border-slate-700 flex justify-end">
              <button onClick={close} className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded">
                {applyResult ? 'Close' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function DiffResult({ result, kind, label }) {
  const items = result.items?.[kind] || []
  const counts = result.summary?.[kind]
  if (!counts || counts.total === 0) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded p-3 text-sm text-slate-400">
        {label}: no {kind} affected.
      </div>
    )
  }
  return (
    <div className="bg-slate-800 rounded border border-slate-700 overflow-hidden">
      <div className="px-3 py-2 bg-slate-700/50 text-sm text-slate-200">
        <span className="font-medium">{label} — {kind}</span>
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
          {items.map((it, i) => (
            <tr key={i}>
              <td className="px-3 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${ACTION_STYLE[it.action] || 'bg-slate-500 text-white'}`}>
                  {(it.action || 'unknown').toUpperCase()}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-slate-200">{it._id}</td>
              <td className="px-3 py-2 text-slate-300">
                {it.action === 'error' && <span className="text-red-400">{it.error}</span>}
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
                {it.ref_notes && it.ref_notes.length > 0 && (
                  <ul className="mt-1 ml-4 text-xs text-amber-400 list-disc list-inside">
                    {it.ref_notes.map((n, j) => <li key={j}>{n}</li>)}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
