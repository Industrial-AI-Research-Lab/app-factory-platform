import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Settings } from 'lucide-react'
import { apiFetch } from '../utils_api'
import { computePopoverPosition } from '../utils/popoverPosition'

// Position math must run before paint on the client, but useLayoutEffect warns
// under SSR; fall back to useEffect where there is no DOM.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Cog on an agent/tool row: opens a popover with the request's actual model
 * (joined from agent_llm_calls by eventEnrichment), its reasoning effort (fetched
 * on open — it isn't in the list summary), and same-origin "Edit" links to the
 * agent / MCP / A2A config, opened in a new tab. Renders nothing when the row has
 * no joined model or server, so plain rows stay clean.
 *
 * The Edit links carry ?agent=/?server= so the target config page can preselect
 * the entity. The panel is portaled to <body> with fixed positioning: the event
 * rows clip overflow (for rounded corners), which would otherwise cut it off.
 */
export default function EventModelCog({ event }) {
  const model = event?._model || ''
  const server = event?._server || ''
  const callId = event?._modelCallId || ''
  const [open, setOpen] = useState(false)
  const [reasoning, setReasoning] = useState('')
  const [fetched, setFetched] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const panelRef = useRef(null)

  const reposition = useCallback(() => {
    const btn = btnRef.current
    if (!btn || typeof window === 'undefined') return
    const anchor = btn.getBoundingClientRect()
    const height = panelRef.current ? panelRef.current.offsetHeight : 0
    setPos(computePopoverPosition(anchor, { width: window.innerWidth, height: window.innerHeight }, { width: 288, height }))
  }, [])

  useEffect(() => {
    if (!open || fetched || !callId) return undefined
    let alive = true
    apiFetch(`/agent-llm-calls/${callId}`)
      .then((r) => (r && r.ok ? r.json() : null))
      .then((doc) => { if (alive) { setReasoning(doc?.request?.params?.reasoning_effort || ''); setFetched(true) } })
      .catch(() => { if (alive) setFetched(true) })
    return () => { alive = false }
  }, [open, fetched, callId])

  useIsoLayoutEffect(() => {
    if (!open) return undefined
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
    // `reasoning` is fetched after the panel opens and adds a line; re-run so the
    // height is re-measured and top is recomputed when the panel flips above.
  }, [open, reposition, reasoning])

  if (!model && !server) return null

  const agentId = event?._agentId || ''
  const editRef = event?._serverEditRef || ''
  const editAgent = `/configurations/agents${agentId ? `?agent=${encodeURIComponent(agentId)}` : ''}`
  const isA2A = event?._serverKind === 'a2a'
  const editServer = isA2A
    ? `/configurations/a2a${editRef ? `?agent=${encodeURIComponent(editRef)}` : ''}`
    : `/configurations/mcp-tools${editRef ? `?server=${encodeURIComponent(editRef)}` : ''}`

  return (
    <span className="inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setPos(null); setOpen((o) => !o) }}
        className="text-slate-500 hover:text-slate-300 p-0.5 rounded"
        title="Model & config"
        aria-label="Model and config"
      >
        <Settings className="w-3.5 h-3.5" />
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <div
            ref={panelRef}
            className="fixed z-50 w-72 rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-3 text-xs text-slate-300 space-y-2"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            {model ? (
              <div>
                <div className="text-slate-500">model</div>
                <div className="font-mono text-slate-200 break-all">{model}</div>
                {reasoning && (
                  <div className="text-slate-400 mt-0.5">reasoning: <span className="font-mono">{reasoning}</span></div>
                )}
              </div>
            ) : (
              <div className="text-slate-500">no model recorded for this row</div>
            )}
            {agentId && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-slate-300 truncate">{event._agentLabel || agentId}</span>
                <a href={editAgent} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline whitespace-nowrap">Edit agent</a>
              </div>
            )}
            {server && (
              <div className="border-t border-slate-700 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-300 truncate">{server}</span>
                  <a href={editServer} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline whitespace-nowrap">{isA2A ? 'Edit A2A' : 'Edit MCP'}</a>
                </div>
                {event._address && <div className="font-mono text-slate-500 break-all mt-0.5">{event._address}</div>}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </span>
  )
}
