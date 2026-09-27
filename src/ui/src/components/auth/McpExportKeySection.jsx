import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus, Trash2, X } from 'lucide-react'
import { apiFetch } from '../../utils_api'

function formatWhen(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

export default function McpExportKeySection({ tenantId }) {
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [newName, setNewName] = useState('mcp-export')
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState(null)
  const [copyDone, setCopyDone] = useState(false)

  const fetchKeys = useCallback(async () => {
    if (!tenantId) {
      setKeys([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/tenants/${tenantId}/mcp-export-keys`)
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to load export keys')
      }
      const data = await res.json()
      setKeys(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load export keys')
      setKeys([])
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  const createKey = async () => {
    if (!tenantId) return
    const name = (newName || 'mcp-export').trim() || 'mcp-export'
    if (keys.some(k => (k.name || '').trim().toLowerCase() === name.toLowerCase())) {
      alert(`Key name "${name}" already exists`)
      return
    }
    setCreating(true)
    setError(null)
    try {
      const res = await apiFetch(`/tenants/${tenantId}/mcp-export-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to create export key')
      }
      const data = await res.json()
      setCreatedKey(data.api_key || '')
      setCopyDone(false)
      await fetchKeys()
    } catch (err) {
      alert(`Create failed: ${err.message}`)
    } finally {
      setCreating(false)
    }
  }

  const revokeKey = async (row) => {
    if (!confirm(`Revoke export key "${row.name}" (${row.id})?`)) return
    try {
      const res = await apiFetch(`/tenants/${tenantId}/mcp-export-keys/${row.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to revoke key')
      }
      await fetchKeys()
    } catch (err) {
      alert(`Revoke failed: ${err.message}`)
    }
  }

  const copyCreatedKey = async () => {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey)
      setCopyDone(true)
      setTimeout(() => setCopyDone(false), 2000)
    } catch {
      alert('Copy failed — select and copy the key manually')
    }
  }

  const closeCreatedModal = () => {
    setCreatedKey(null)
    setCopyDone(false)
  }

  return (
    <div className="mt-6 pt-4 border-t border-slate-600">
      <h3 className="text-sm font-semibold text-slate-200 mb-1">MCP export keys</h3>
      <p className="text-xs text-slate-400 mb-3">
        Tenant keys for read-only HTTP MCP export in Cursor (tenant admin). Each key is shown once on create.
      </p>

      {error && (
        <div className="text-xs text-red-300 mb-2">{error}</div>
      )}

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="block flex-1 min-w-[140px]">
          <span className="text-xs text-slate-400">Key name</span>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
            disabled={creating}
          />
        </label>
        <button
          type="button"
          onClick={createKey}
          disabled={creating || loading}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" />
          {creating ? 'Creating...' : 'New key'}
        </button>
      </div>

      {loading && <div className="text-xs text-slate-400">Loading...</div>}

      {!loading && keys.length === 0 && (
        <div className="text-xs text-slate-500">No export keys yet.</div>
      )}

      {!loading && keys.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 text-left border-b border-slate-600">
                <th className="py-2 pr-2">Name</th>
                <th className="py-2 pr-2">ID</th>
                <th className="py-2 pr-2">Created</th>
                <th className="py-2 pr-2">Last used</th>
                <th className="py-2 pr-2">Enabled</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(row => (
                <tr key={row.id} className="border-b border-slate-700/50">
                  <td className="py-2 pr-2">{row.name}</td>
                  <td className="py-2 pr-2 font-mono text-slate-300">{row.id}</td>
                  <td className="py-2 pr-2 whitespace-nowrap">{formatWhen(row.created_at)}</td>
                  <td className="py-2 pr-2 whitespace-nowrap">{formatWhen(row.last_used_at)}</td>
                  <td className="py-2 pr-2">{row.enabled ? 'yes' : 'no'}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => revokeKey(row)}
                      className="px-2 py-1 text-red-400 hover:text-red-300"
                      title="Revoke key"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createdKey && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-lg p-6 mx-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Export key created</h2>
              <button type="button" onClick={closeCreatedModal} aria-label="Close">
                <X className="w-5 h-5 text-slate-400 hover:text-white" />
              </button>
            </div>
            <p className="text-sm text-red-300 mb-3">
              Copy this key now. You will not be able to see it again.
            </p>
            <pre className="bg-slate-900 border border-slate-600 rounded p-3 text-xs font-mono break-all text-slate-200 mb-4 max-h-32 overflow-auto">
              {createdKey}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={copyCreatedKey}
                className="px-4 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1"
              >
                <Copy className="w-3.5 h-3.5" />
                {copyDone ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={closeCreatedModal}
                className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
