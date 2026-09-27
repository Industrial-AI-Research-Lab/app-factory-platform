import { useEffect, useRef } from 'react'
import { Search, X, Activity, List } from 'lucide-react'
import EventFacetDropdown from './EventFacetDropdown'
import { STATUS_LABEL } from '../../utils/eventFacets'

function SegButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${
        active ? 'bg-slate-600 text-slate-100 shadow' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {children}
    </button>
  )
}

function Chip({ label, value, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs bg-slate-700 border border-slate-600 text-slate-200 rounded-full pl-2.5 pr-1 py-1">
      {label && <span className="text-slate-400">{label}</span>}
      <span className="font-mono">{value}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} ${value}`}
        className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-white/5 hover:bg-white/20"
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  )
}

/**
 * The Events tab toolbar: free-text/token search, one dropdown per facet, the
 * Signal/Raw view toggle with a "telemetry hidden" note, and removable chips
 * for the active query + facet selections. Pure presentation — all state lives
 * in EventsTab; `counts`/`teleHidden`/`shown`/`total` come from the facet view.
 */
export default function EventFilterBar({
  level, onLevelChange,
  query, onQueryChange,
  facets, counts, selected,
  onToggle, onClearFacet, onClearAll,
  teleHidden, shown, total,
}) {
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
      } else if (e.key === 'Escape' && el === inputRef.current) {
        if (query) onQueryChange('')
        else inputRef.current?.blur()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [query, onQueryChange])

  const hasActive = Boolean(query.trim()) || facets.some((f) => (selected[f.key]?.size || 0) > 0)

  return (
    <div className="flex flex-col gap-3 mb-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search agents · tools · results  (or agent: tool: status:)…"
            autoComplete="off"
            spellCheck={false}
            aria-label="Search events"
            className="w-full bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder:text-slate-500 pl-9 pr-9 py-2 focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded bg-slate-700 text-slate-300 hover:bg-slate-600"
            >
              <X className="w-3 h-3" />
            </button>
          ) : (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-slate-500 border border-slate-700 rounded px-1.5 py-px">
              /
            </span>
          )}
        </div>
        {facets.map((f) => (
          <EventFacetDropdown
            key={f.key}
            facet={f}
            counts={counts[f.key] || new Map()}
            selected={selected[f.key] || new Set()}
            onToggle={(v) => onToggle(f.key, v)}
            onClear={() => onClearFacet(f.key)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex bg-slate-900 border border-slate-600 rounded-lg p-1" role="group" aria-label="View level">
          <SegButton active={level === 'signal'} onClick={() => onLevelChange('signal')} icon={Activity}>Signal</SegButton>
          <SegButton active={level === 'raw'} onClick={() => onLevelChange('raw')} icon={List}>Raw</SegButton>
        </div>
        <span className="font-mono text-xs text-slate-400 whitespace-nowrap">
          Showing <b className="text-slate-200 font-semibold">{shown}</b> of {total}
        </span>
        <div className="flex-1" />
        {teleHidden > 0 && (
          <span className="inline-flex items-center gap-2 text-xs text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            {teleHidden} telemetry event{teleHidden > 1 ? 's' : ''} hidden
            <button type="button" onClick={() => onLevelChange('raw')} className="text-blue-400 font-medium hover:underline">
              Show all
            </button>
          </span>
        )}
      </div>

      {hasActive && (
        <div className="flex flex-wrap items-center gap-2">
          {query.trim() && (
            <Chip label="search" value={`“${query.trim()}”`} onRemove={() => onQueryChange('')} />
          )}
          {facets.flatMap((f) =>
            [...(selected[f.key] || [])].map((v) => (
              <Chip
                key={`${f.key}:${v}`}
                label={f.key === 'status' ? 'status' : f.label}
                value={f.key === 'status' ? (STATUS_LABEL[v] || v) : v}
                onRemove={() => onToggle(f.key, v)}
              />
            )),
          )}
          <button
            type="button"
            onClick={onClearAll}
            className="text-xs text-slate-400 hover:text-red-400 underline underline-offset-2"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
