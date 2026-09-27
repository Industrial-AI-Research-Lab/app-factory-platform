import { Plus, X } from 'lucide-react'

export default function HeadersEditor({ headers, onChange }) {
  const add = () => onChange([...headers, { name: '', value: '' }])
  const remove = (i) => onChange(headers.filter((_, idx) => idx !== i))
  const update = (i, field, val) => {
    const next = headers.map((h, idx) => (idx === i ? { ...h, [field]: val } : h))
    onChange(next)
  }
  return (
    <div className="space-y-1.5">
      {headers.map((h, i) => (
        <div key={i} className="flex gap-1.5 items-center">
          <input
            type="text"
            value={h.name}
            placeholder="Header name"
            onChange={e => update(i, 'name', e.target.value)}
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs"
          />
          <input
            type="text"
            value={h.value}
            placeholder="Header value"
            onChange={e => update(i, 'value', e.target.value)}
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs"
          />
          <button type="button" onClick={() => remove(i)} className="text-slate-400 hover:text-red-400">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 mt-1"
      >
        <Plus className="w-3 h-3" /> Add header
      </button>
    </div>
  )
}
