import { useState } from 'react'
import { X } from 'lucide-react'
import HeadersEditor from './HeadersEditor'
import { headersObjectToList } from '../../utils/mcp_cursor_preset'

// Match mcp_executor when fields are missing from the tool doc.
const RUNTIME_DEFAULT_MODE = 'http'
const RUNTIME_DEFAULT_TIMEOUT = '60'

function headersFromRuntime(rt) {
  const raw = rt?.headers
  if (Array.isArray(raw)) {
    return raw
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({ name: String(h.name || ''), value: String(h.value || '') }))
  }
  if (raw && typeof raw === 'object') return headersObjectToList(raw)
  return []
}

export function formFromServerTools(tools) {
  const tool = (tools || []).find((t) => String(t?.tenant_id || '') !== '__system__') || (tools || [])[0]
  const rt = (tool?.metadata && tool.metadata.external_mcp) || {}
  const hadMode = rt.mode != null && String(rt.mode).trim() !== ''
  const hadTimeout = rt.timeout_seconds != null && rt.timeout_seconds !== ''
  return {
    endpoint: String(rt.endpoint || ''),
    mode: hadMode ? String(rt.mode) : RUNTIME_DEFAULT_MODE,
    timeout_seconds: hadTimeout ? String(rt.timeout_seconds) : RUNTIME_DEFAULT_TIMEOUT,
    hadMode,
    hadTimeout,
    headers: headersFromRuntime(rt),
  }
}

export default function McpServerSettingsModal({
  serverId,
  tenantId,
  isRoot = false,
  form,
  setForm,
  error,
  saving,
  onClose,
  onSave,
}) {
  const [localError, setLocalError] = useState(null)
  const err = error || localError

  const submit = () => {
    setLocalError(null)
    const timeout = Number(form.timeout_seconds)
    if (!Number.isFinite(timeout) || timeout < 1) {
      setLocalError('Timeout must be a number >= 1')
      return
    }
    const mode = String(form.mode || '').trim()
    const body = {
      // Root may pass __system__ for in-place platform edits. Tenant_admin must
      // omit it so resolve uses their tenant and returns fork_required.
      ...(tenantId && (isRoot || tenantId !== '__system__') ? { tenant_id: tenantId } : {}),
      endpoint: String(form.endpoint || '').trim() || undefined,
      headers: (form.headers || []).filter((h) => (h.name || '').trim()),
    }
    // Do not invent mode/timeout on Save when the doc never stored them and the
    // user left the runtime-default display values untouched.
    if (form.hadMode || mode !== RUNTIME_DEFAULT_MODE) {
      body.mode = mode || undefined
    }
    if (form.hadTimeout || timeout !== Number(RUNTIME_DEFAULT_TIMEOUT)) {
      body.timeout_seconds = timeout
    }
    onSave(body)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg bg-slate-800 border border-slate-600 rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-slate-100 truncate">Server settings</h2>
            <p className="text-xs text-slate-400 font-mono truncate">
              {serverId} · {tenantId}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <label className="block text-xs text-slate-400">
            Endpoint
            <input
              type="text"
              value={form.endpoint}
              onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
              className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100"
              placeholder="https://example.com/mcp"
            />
          </label>
          <div className="flex gap-2">
            <label className="block text-xs text-slate-400 flex-1">
              Mode
              <select
                value={form.mode}
                onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
                className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100"
              >
                <option value="http">http</option>
                <option value="streamable-http">streamable-http</option>
              </select>
            </label>
            <label className="block text-xs text-slate-400 w-28">
              Timeout (s)
              <input
                type="number"
                min={1}
                value={form.timeout_seconds}
                onChange={(e) => setForm((f) => ({ ...f, timeout_seconds: e.target.value }))}
                className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100"
              />
            </label>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">HTTP headers</div>
            <HeadersEditor
              headers={form.headers}
              onChange={(headers) => setForm((f) => ({ ...f, headers }))}
            />
          </div>
          {err && (
            <div className="text-xs text-red-300 bg-red-950/40 border border-red-900/50 rounded px-2 py-1.5">
              {err}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
