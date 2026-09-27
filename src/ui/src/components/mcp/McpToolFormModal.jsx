import { Save, X } from 'lucide-react'
import { SHORT_DESCRIPTION_MAX_LEN } from '../../utils/entity_descriptions'

export default function McpToolFormModal({
  open,
  editingId,
  form,
  setForm,
  modalError,
  formIdHasSpaces,
  saving,
  onClose,
  onSave,
  onClearModalError,
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-2 overflow-y-auto">
      <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-2xl p-6 my-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{editingId ? 'Edit MCP Tool' : 'New MCP Tool'}</h2>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-slate-400 hover:text-white" /></button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-slate-400">ID</span>
            <input
              type="text"
              value={form.id}
              disabled={!!editingId}
              onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
              className={`w-full bg-slate-700 border rounded px-2 py-1.5 text-sm mt-1 disabled:opacity-50 ${
                formIdHasSpaces ? 'border-red-500' : 'border-slate-600'
              }`}
            />
            {formIdHasSpaces && (
              <p className="mt-1 text-xs text-red-300">Tool ID cannot contain spaces. Use &quot;-&quot; or &quot;_&quot;.</p>
            )}
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Wire name</span>
            <input
              type="text"
              value={form.name}
              onChange={e => {
                setForm(f => ({ ...f, name: e.target.value }))
                if (onClearModalError) onClearModalError()
              }}
              className={`w-full bg-slate-700 border rounded px-2 py-1.5 text-sm mt-1 font-mono ${
                modalError?.code === 'name_conflict' ? 'border-amber-500' : 'border-slate-600'
              }`}
            />
            <p className="mt-1 text-xs text-slate-500">
              Path A identity: LLM function name and allow-list ref (max 64 chars, [a-zA-Z0-9_-]).
            </p>
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">MCP RPC name</span>
            <input
              type="text"
              value={form.rpc_name}
              onChange={e => {
                setForm(f => ({ ...f, rpc_name: e.target.value }))
                if (onClearModalError) onClearModalError()
              }}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
            />
            <p className="mt-1 text-xs text-slate-500">RPC contract for tools/call (up to 128 chars per MCP spec).</p>
          </label>
          {modalError && (
            <div className="bg-red-900/40 border border-red-700 text-red-200 rounded px-3 py-2 text-xs space-y-1.5">
              <p>{modalError.message}</p>
              {modalError.code === 'name_conflict' && modalError.suggested_name && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-400">Suggested name:</span>
                  <code className="bg-slate-700 px-1.5 py-0.5 rounded font-mono">{modalError.suggested_name}</code>
                  <button
                    type="button"
                    onClick={() => {
                      setForm(f => ({ ...f, name: modalError.suggested_name }))
                      if (onClearModalError) onClearModalError()
                    }}
                    className="px-2 py-0.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs"
                  >
                    Use this name
                  </button>
                </div>
              )}
            </div>
          )}
          <label className="block">
            <span className="text-xs text-slate-400">Short description</span>
            <input
              type="text"
              maxLength={SHORT_DESCRIPTION_MAX_LEN}
              value={form.short_description}
              onChange={e => setForm(f => ({ ...f, short_description: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Long description</span>
            <textarea
              value={form.long_description}
              onChange={e => setForm(f => ({ ...f, long_description: e.target.value }))}
              placeholder="Optional details for LLM tool schema"
              rows={3}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">MCP server ID (server identifier in config)</span>
            <input
              type="text"
              value={form.mcp_server}
              onChange={e => setForm(f => ({ ...f, mcp_server: e.target.value }))}
              placeholder="my_mcp_server"
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded border border-slate-600/80 bg-slate-900/30">
            <label className="block">
              <span className="text-xs text-slate-400">Container scope (local Docker HTTP)</span>
              <select
                value={form.mcp_runtime_scope}
                onChange={e => setForm(f => ({ ...f, mcp_runtime_scope: e.target.value }))}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
              >
                <option value="project">Project (remove when project completes)</option>
                <option value="tenant">Tenant (shared per tenant; idle stops container)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">Idle timeout, sec (empty = default, -1 = no idle stop)</span>
              <input
                type="text"
                inputMode="numeric"
                value={form.mcp_idle_timeout}
                onChange={e => setForm(f => ({ ...f, mcp_idle_timeout: e.target.value }))}
                placeholder="600"
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">On project complete (Docker)</span>
              <select
                value={form.mcp_on_project_complete}
                onChange={e => setForm(f => ({ ...f, mcp_on_project_complete: e.target.value }))}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
              >
                <option value="remove">Stop and remove</option>
                <option value="stop_only">Stop only (no docker rm; for -1 / long-lived)</option>
              </select>
            </label>
          </div>
          <p className="text-xs text-slate-500 -mt-1">
            Tenant: container is fully removed only when the tool is deleted from configuration.
            -1 for idle disables idle stop; container runs without <code className="text-slate-400">--rm</code>; stop behavior follows the options above.
          </p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              className="accent-blue-500"
            />
            <span className="text-sm">Enabled</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded">Cancel</button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || formIdHasSpaces}
            className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
