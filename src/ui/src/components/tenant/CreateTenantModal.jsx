import { Save, X } from 'lucide-react'

export default function CreateTenantModal({ show, form, setForm, onClose, onCreate, saving }) {
  if (!show) return null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">New Tenant</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-slate-400 hover:text-white" /></button>
        </div>
        <div className="space-y-3">
          <label className="block"><span className="text-xs text-slate-400">Tenant ID</span><input type="text" placeholder="acme" value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
          <label className="block"><span className="text-xs text-slate-400">Tenant Name</span><input type="text" placeholder="Acme Corp" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="accent-blue-500" /><span className="text-sm">Enabled</span></label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded">Cancel</button>
          <button onClick={onCreate} disabled={saving} className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50">
            <Save className="w-3.5 h-3.5" /> {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

