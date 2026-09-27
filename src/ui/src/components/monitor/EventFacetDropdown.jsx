import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { STATUS_LABEL } from '../../utils/eventFacets'

const LONG_LIST = 7

/**
 * One facet's dropdown: a button that opens a checkbox list of the facet's
 * values with per-value counts. `counts` is the option->count Map for this
 * facet (already computed over the other active facets). Toggling a value calls
 * `onToggle`. Closes on outside click / Escape.
 */
export default function EventFacetDropdown({ facet, counts, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const options = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))
  const labelFor = (v) => (facet.key === 'status' ? (STATUS_LABEL[v] || v) : v)
  const shown = filter
    ? options.filter((o) => labelFor(o).toLowerCase().includes(filter.toLowerCase()))
    : options
  const nSel = selected.size

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 text-sm rounded-lg px-3 py-2 border transition-colors ${
          nSel
            ? 'border-blue-500 text-blue-300 bg-blue-500/10'
            : 'border-slate-600 text-slate-300 bg-slate-700 hover:bg-slate-600'
        }`}
      >
        <span>{facet.label}</span>
        {nSel > 0 && (
          <span className="font-mono text-[10px] min-w-[16px] text-center bg-blue-500 text-slate-950 rounded-full px-1.5 py-px">
            {nSel}
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-40 top-[calc(100%+6px)] left-0 min-w-[248px] max-w-[320px] bg-slate-800 border border-slate-600 rounded-xl shadow-xl p-2">
          {options.length > LONG_LIST && (
            <input
              type="search"
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${facet.label.toLowerCase()}…`}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 mb-1.5 focus:outline-none focus:ring-2 focus:ring-slate-500"
            />
          )}
          <div className="max-h-64 overflow-auto flex flex-col gap-px">
            {shown.length === 0 ? (
              <div className="text-xs text-slate-500 px-2 py-1.5">No values</div>
            ) : shown.map((v) => {
              const on = selected.has(v)
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => onToggle(v)}
                  aria-checked={on}
                  role="menuitemcheckbox"
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left w-full hover:bg-slate-700/60"
                >
                  <span className={`w-4 h-4 rounded flex items-center justify-center border flex-none ${
                    on ? 'bg-blue-500 border-blue-500' : 'border-slate-500'
                  }`}>
                    {on && <Check className="w-3 h-3 text-slate-950" />}
                  </span>
                  <span className={`flex-1 text-sm text-slate-200 truncate ${facet.mono ? 'font-mono text-xs' : ''}`}>
                    {labelFor(v)}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">{counts.get(v)}</span>
                </button>
              )
            })}
          </div>
          <div className="flex justify-between items-center pt-2 mt-1 border-t border-slate-700 px-1">
            <span className="text-[11px] text-slate-500 font-mono">{options.length} values</span>
            <button
              type="button"
              onClick={() => { onClear(); setFilter('') }}
              className="text-[11px] text-slate-400 hover:text-blue-400"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
