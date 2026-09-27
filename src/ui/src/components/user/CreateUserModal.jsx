import { Save, X } from 'lucide-react'

export default function CreateUserModal({
  show,
  onClose,
  createForm,
  setCreateForm,
  availableRoles,
  isRoot,
  tenants,
  saving,
  onCreate,
}) {
  if (!show) return null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">New User</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400 hover:text-white" /></button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-slate-400">Email</span>
            <input type="email" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Name</span>
            <input type="text" value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Password (min 8 chars)</span>
            <input type="password" value={createForm.password} onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Role</span>
            <select value={createForm.role} onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1">
              {availableRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          {isRoot && (
            <label className="block">
              <span className="text-xs text-slate-400">Tenant</span>
              <select value={createForm.tenant_id} onChange={e => setCreateForm(f => ({ ...f, tenant_id: e.target.value }))}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1">
                <option value="">-- inherit from me --</option>
                {tenants.map(t => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={createForm.enabled} onChange={e => setCreateForm(f => ({ ...f, enabled: e.target.checked }))} className="accent-blue-500" />
            <span className="text-sm">Enabled</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded">Cancel</button>
          <button onClick={onCreate} disabled={saving}
            className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50">
            <Save className="w-3.5 h-3.5" /> {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
