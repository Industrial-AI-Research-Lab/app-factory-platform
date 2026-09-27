import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useModels } from '../hooks/useModels'

export default function ModelPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)
  const sentinelRef = useRef(null)

  const { models, loading, loadingMore, hasMore, fetchMore } = useModels({
    q: search,
    limit: 50,
    enabled: open,
  })

  useEffect(() => {
    if (!sentinelRef.current) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) fetchMore() },
      { threshold: 0.1 }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [fetchMore])

  useEffect(() => {
    if (!open) { setSearch(''); return }
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-left hover:border-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <span className="truncate text-slate-200">{value || '-- select model --'}</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-1 flex-shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[280px] bg-slate-800 border border-slate-600 rounded-lg shadow-xl">
          <div className="relative border-b border-slate-600">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent pl-8 pr-3 py-2 text-sm text-slate-200 focus:outline-none"
              autoFocus
            />
          </div>

          <button
            type="button"
            onClick={() => { onChange(''); setOpen(false) }}
            className={`w-full text-left px-3 py-2 text-sm border-b border-slate-700 hover:bg-slate-700 ${!value ? 'text-blue-300' : 'text-slate-400'}`}
          >
            -- select model --
          </button>

          <div className="max-h-56 overflow-y-auto">
            {loading && models.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-400 text-center">Loading…</div>
            ) : models.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-400 text-center">No models found</div>
            ) : (
              <>
                {models.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { onChange(m.id); setOpen(false); setSearch('') }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700 ${value === m.id ? 'bg-blue-900/40 text-blue-200' : 'text-slate-200'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{m.name || m.id}</span>
                      <span className={`text-xs flex-shrink-0 ${m.is_free ? 'text-green-400' : 'text-slate-500'}`}>
                        {m.is_free ? 'Free' : m.provider || ''}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{m.id}</div>
                  </button>
                ))}
                {hasMore && (
                  <div ref={sentinelRef} className="py-2 text-center">
                    {loadingMore
                      ? <span className="text-xs text-slate-400">Loading more…</span>
                      : <span className="text-xs text-slate-600">Scroll for more</span>
                    }
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
