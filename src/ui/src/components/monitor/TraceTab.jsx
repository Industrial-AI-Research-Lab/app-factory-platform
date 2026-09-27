import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'
import { apiFetch } from '../../utils_api'
import AgentInvocationInspector from '../AgentInvocationInspector'
import TraceNode from './TraceNode'
import TraceDetailsPanel from './TraceDetailsPanel'
import { findTraceMatches, formatInvocation, layoutTraceNodes, searchViewportZoom, TRACE_LEGEND, traceEdgeView, traceGraphForView, traceProjectChanged, traceRefreshDelay, traceRefreshKey } from './traceViewModel'

const nodeTypes = { trace: TraceNode }
const MINIMAP_COLORS = {
  gray: '#9ca3af', slate: '#94a3b8', blue: '#60a5fa', emerald: '#34d399', violet: '#a78bfa',
  amber: '#fbbf24', sky: '#38bdf8', orange: '#fb923c', rose: '#fb7185', cyan: '#22d3ee',
  fuchsia: '#e879f9', purple: '#c084fc', teal: '#2dd4bf', pink: '#f472b6', indigo: '#818cf8',
  yellow: '#facc15', lime: '#a3e635', stone: '#a8a29e', red: '#f87171', green: '#4ade80', zinc: '#a1a1aa',
}
const LEGEND_DOT_CLASSES = {
  gray: 'bg-gray-400', slate: 'bg-slate-400', blue: 'bg-blue-400', emerald: 'bg-emerald-400', violet: 'bg-violet-400',
  amber: 'bg-amber-400', sky: 'bg-sky-400', orange: 'bg-orange-400', rose: 'bg-rose-400', cyan: 'bg-cyan-400',
  fuchsia: 'bg-fuchsia-400', purple: 'bg-purple-400', teal: 'bg-teal-400', pink: 'bg-pink-400', indigo: 'bg-indigo-400',
  yellow: 'bg-yellow-400', lime: 'bg-lime-400', stone: 'bg-stone-400', red: 'bg-red-400', green: 'bg-green-400', zinc: 'bg-zinc-400',
}
const TRACE_FILTERS = [['agents', 'Agents'], ['llm', 'LLM'], ['tools', 'Tools'], ['checkpoints', 'Checkpoints']]

function defaultViewSettings(mode) {
  return {
    runId: '',
    enabled: { agents: true, llm: mode === 'full', tools: true, checkpoints: mode === 'full' },
    collapsedIds: [],
  }
}

function detailRounds(selected) {
  return (selected?.details?.llm_rounds || []).map(round => ({ callId: round.call_id, turnIndex: round.turn_index }))
}

export default function TraceTab({ projectId, events = [] }) {
  const [trace, setTrace] = useState(null)
  const [requestError, setRequestError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [traceMode, setTraceMode] = useState('full')
  const [viewSettings, setViewSettings] = useState({ full: defaultViewSettings('full'), short: defaultViewSettings('short') })
  const [payloadLoading, setPayloadLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const requestSequence = useRef(0)
  const activeController = useRef(null)
  const initialLoadStarted = useRef(false)
  const lastRefreshRevision = useRef('')
  const lastTraceRequestAt = useRef(null)
  const previousProjectId = useRef(null)
  const flowInstance = useRef(null)
  const flowContainer = useRef(null)

  const fetchTrace = useCallback(async (query = '', options = {}) => {
    const response = await apiFetch(`/projects/${projectId}/execution-trace${query}`, options)
    if (!response.ok) throw new Error(`Trace request failed (${response.status})`)
    return response.json()
  }, [projectId])

  const loadTrace = useCallback(async ({ initial = false, revision = '' } = {}) => {
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    lastTraceRequestAt.current = Date.now()
    const sequence = ++requestSequence.current
    try {
      const result = await fetchTrace('', { signal: controller.signal })
      if (sequence !== requestSequence.current) return
      setTrace(result)
      setSelected(current => {
        if (!current) return current
        return result.nodes?.find(node => node.id === current.id) || null
      })
      setRequestError(null)
      if (revision) lastRefreshRevision.current = revision
    } catch (error) {
      if (error?.name === 'AbortError' || sequence !== requestSequence.current) return
      if (initial) {
        setTrace({ completeness: { status: 'partial', warnings: ['Trace request unavailable'] }, nodes: [], edges: [], stats: {} })
      }
      setRequestError(error.message)
    }
  }, [fetchTrace])

  const liveRevision = useMemo(() => traceRefreshKey(events), [events])

  useEffect(() => {
    if (!traceProjectChanged(previousProjectId.current, projectId)) {
      previousProjectId.current = projectId
      return
    }

    previousProjectId.current = projectId
    activeController.current?.abort()
    requestSequence.current += 1
    initialLoadStarted.current = false
    lastRefreshRevision.current = ''
    lastTraceRequestAt.current = null
    setTrace(null)
    setSelected(null)
    setRequestError(null)
    setPayloadLoading(false)
    setSearchQuery('')
    setSearchIndex(0)
    setTraceMode('full')
    setViewSettings(current => ({
      ...current,
      full: { ...defaultViewSettings('full') },
      short: { ...defaultViewSettings('short') },
    }))
  }, [projectId])

  useEffect(() => {
    if (initialLoadStarted.current) return undefined
    initialLoadStarted.current = true
    loadTrace({ initial: true, revision: liveRevision })
    return () => {
      activeController.current?.abort()
      initialLoadStarted.current = false
    }
  }, [loadTrace])

  useEffect(() => {
    if (!trace || !liveRevision || liveRevision === lastRefreshRevision.current) return undefined
    const delay = Math.max(350, traceRefreshDelay(lastTraceRequestAt.current))
    const timer = window.setTimeout(() => loadTrace({ revision: liveRevision }), delay)
    return () => window.clearTimeout(timer)
  }, [liveRevision, loadTrace, trace])

  const activeSettings = viewSettings[traceMode]
  const visibleTrace = useMemo(() => traceGraphForView(trace, traceMode, activeSettings), [trace, traceMode, activeSettings])
  const expandedTrace = useMemo(
    () => traceGraphForView(trace, traceMode, { ...activeSettings, collapsedIds: [] }),
    [trace, traceMode, activeSettings],
  )
  const laidOutNodes = useMemo(() => layoutTraceNodes(visibleTrace.nodes), [visibleTrace.nodes])
  const searchMatches = useMemo(
    () => findTraceMatches(laidOutNodes.map(node => node.data.trace), searchQuery),
    [laidOutNodes, searchQuery],
  )
  const activeMatch = searchMatches[searchIndex] || null
  const searchMatchIds = useMemo(() => new Set(searchMatches.map(node => node.id)), [searchMatches])
  const activeMatchId = activeMatch?.id || null
  const visibleNodes = useMemo(() => laidOutNodes.map(node => ({
    ...node,
    data: {
      ...node.data,
      searchMatch: searchMatchIds.has(node.id),
      searchActive: node.id === activeMatchId,
    },
  })), [laidOutNodes, searchMatchIds, activeMatchId])
  const visibleEdges = useMemo(() => {
    const ids = new Set(visibleNodes.map(node => node.id))
    return visibleTrace.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(traceEdgeView)
  }, [visibleTrace.edges, visibleNodes])
  const rounds = useMemo(() => detailRounds(selected), [selected])
  const firstCallId = rounds[0]?.callId
  const runs = useMemo(() => (trace?.nodes || []).filter(node => node.type === 'run').sort((left, right) => {
    const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER
    const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER
    return leftSequence - rightSequence || String(left.id).localeCompare(String(right.id))
  }), [trace])
  const collapsibleIds = useMemo(() => {
    const visibleIds = new Set(expandedTrace.nodes.map(node => node.id))
    const parentIds = new Set(expandedTrace.nodes.filter(node => node.parent_id).map(node => node.parent_id))
    return expandedTrace.nodes.filter(node => parentIds.has(node.id) && (!node.parent_id || !visibleIds.has(node.parent_id)))
      .map(node => node.id)
  }, [expandedTrace.nodes])

  const updateSettings = updater => {
    setSelected(null)
    setSearchIndex(0)
    setViewSettings(current => ({ ...current, [traceMode]: updater(current[traceMode]) }))
  }

  const toggleTraceMode = () => {
    setTraceMode(current => current === 'full' ? 'short' : 'full')
    setSelected(null)
    setSearchIndex(0)
  }

  const focusSearchMatch = useCallback(node => {
    if (!node) return
    window.requestAnimationFrame(() => {
      const instance = flowInstance.current
      if (!instance?.setCenter) return
      const nodeView = instance.getNode?.(node.id)
      const position = nodeView?.positionAbsolute || nodeView?.position || { x: 0, y: 0 }
      const width = flowContainer.current?.clientWidth || 1000
      const height = flowContainer.current?.clientHeight || 600
      const nodeWidth = nodeView?.width || nodeView?.measured?.width || 220
      const nodeHeight = nodeView?.height || nodeView?.measured?.height || 90
      const center = { x: position.x + nodeWidth / 2, y: position.y + nodeHeight / 2 }
      instance.setCenter(center.x, center.y, {
        zoom: searchViewportZoom(width, height, instance.getNodes?.() || visibleNodes, center),
        duration: 300,
      })
    })
  }, [visibleNodes])

  const moveSearch = useCallback(delta => {
    setSelected(null)
    setSearchIndex(current => searchMatches.length
      ? (current + delta + searchMatches.length) % searchMatches.length
      : 0)
  }, [searchMatches.length])

  useEffect(() => {
    setSearchIndex(current => searchMatches.length ? Math.min(current, searchMatches.length - 1) : 0)
  }, [searchMatches.length])

  useEffect(() => {
    if (activeMatch) focusSearchMatch(activeMatch)
  }, [activeMatch, focusSearchMatch])

  const loadSelectedPayload = async () => {
    if (!selected?.details?.payload_available) return
    setPayloadLoading(true)
    try {
      const fresh = await fetchTrace(`?include_payloads=true&payload_node_id=${encodeURIComponent(selected.id)}`)
      const updated = fresh.nodes?.find(node => node.id === selected.id)
      if (updated) setSelected(updated)
    } finally {
      setPayloadLoading(false)
    }
  }

  if (!trace) return <div className="p-6 text-slate-400">Loading trace…</div>

  return <div className="relative h-[calc(100vh-250px)] min-h-[560px] bg-slate-900 rounded-lg border border-slate-700 flex flex-col overflow-hidden">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-slate-700 text-xs text-slate-200">
      <button className={`px-2 py-1 rounded ${traceMode === 'short' ? 'bg-cyan-700 hover:bg-cyan-600' : 'bg-slate-700 hover:bg-slate-600'}`} onClick={toggleTraceMode}>{traceMode === 'short' ? 'Full trace' : 'Short trace'}</button>
      <div className="relative flex items-center gap-1" role="search">
        <input aria-label="Search trace nodes" placeholder="Search trace nodes" value={searchQuery} onChange={event => { setSelected(null); setSearchQuery(event.target.value); setSearchIndex(0) }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); moveSearch(event.shiftKey ? -1 : 1) }
        }} className="w-52 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500" />
        {searchQuery.trim() && <div className="flex items-center gap-1">
          <span className="min-w-10 text-center text-[10px] text-slate-400">{searchMatches.length ? `${searchIndex + 1}/${searchMatches.length}` : '0/0'}</span>
          <button type="button" aria-label="Previous trace match" title="Previous trace match" disabled={!searchMatches.length} onClick={() => moveSearch(-1)} className="rounded bg-slate-700 px-1.5 py-1 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40">‹</button>
          <button type="button" aria-label="Next trace match" title="Next trace match" disabled={!searchMatches.length} onClick={() => moveSearch(1)} className="rounded bg-slate-700 px-1.5 py-1 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40">›</button>
        </div>}
        {searchQuery.trim() && <div role="listbox" aria-label="Trace search matches" className="absolute left-0 top-8 z-30 max-h-64 w-80 overflow-auto rounded border border-slate-600 bg-slate-800 p-1 shadow-xl">
          {searchMatches.length ? searchMatches.map((match, index) => <button key={match.id} type="button" role="option" aria-selected={index === searchIndex} onClick={() => { setSelected(null); setSearchIndex(index); focusSearchMatch(match) }} className={`block w-full rounded px-2 py-1.5 text-left text-xs ${index === searchIndex ? 'bg-cyan-800/70 text-cyan-100' : 'text-slate-300 hover:bg-slate-700'}`}>
            <span className="block truncate font-medium">{formatInvocation(match)}</span>
            <span className="block truncate font-mono text-[10px] text-slate-500">{match.details?.task_id || match.details?.tool_call_id || match.run_id || match.id}</span>
          </button>) : <div className="px-2 py-2 text-xs text-slate-500">No matches</div>}
        </div>}
      </div>
      <label className="flex items-center gap-1 text-slate-300">Run
        <select className="rounded border border-slate-600 bg-slate-800 px-1.5 py-1 text-xs text-slate-100" value={activeSettings.runId} onChange={event => updateSettings(settings => ({ ...settings, runId: event.target.value, collapsedIds: [] }))}>
          <option value="">All runs</option>
          {runs.map(run => <option key={run.id} value={run.run_id || run.id}>{run.title || 'Run'} · {run.run_id || run.id}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-1" aria-label="Trace type filters">
        {TRACE_FILTERS.map(([filter, label]) => <button key={filter} type="button" aria-pressed={activeSettings.enabled[filter] !== false} onClick={() => updateSettings(settings => ({ ...settings, enabled: { ...settings.enabled, [filter]: settings.enabled[filter] === false }, collapsedIds: [] }))} className={`rounded px-2 py-1 ${activeSettings.enabled[filter] !== false ? 'bg-slate-700 hover:bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-500 line-through'}`}>{label}</button>)}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600" onClick={() => updateSettings(settings => ({ ...settings, collapsedIds: [] }))}>Expand all</button>
        <button type="button" className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600" onClick={() => updateSettings(settings => ({ ...settings, collapsedIds: collapsibleIds }))}>Collapse all</button>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="font-mono text-slate-300">runs {trace.stats?.runs ?? 0} · tasks {trace.stats?.tasks ?? 0} · agents {trace.stats?.agents ?? 0} · LLM {trace.stats?.llm_calls ?? 0} · tools {trace.stats?.tools ?? 0} · HITL {trace.stats?.approvals ?? 0}</span>
      </div>
    </div>
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-1.5 text-[10px] text-slate-300 border-b border-slate-800" aria-label="Trace legend">
      {TRACE_LEGEND.map(([label, palette]) => <span className="inline-flex items-center gap-1" key={label}><i className={`h-2 w-2 rounded-full ${LEGEND_DOT_CLASSES[palette]}`} />{label}</span>)}
      <span className="ml-auto text-slate-500">solid = structured · dashed = temporal/legacy</span>
    </div>
    {trace.completeness?.status === 'partial' && <div className="px-3 py-2 text-amber-300 text-xs border-b border-amber-800">Partial trace: {(trace.completeness.warnings || []).join(', ')}</div>}
    {requestError && <div className="px-3 py-2 text-rose-300 text-xs border-b border-rose-800">{requestError}</div>}
    <div ref={flowContainer} className="flex-1 min-h-0 relative">
      <ReactFlow style={{ width: '100%', height: '100%' }} nodeTypes={nodeTypes} nodes={visibleNodes} edges={visibleEdges} minZoom={0.5} maxZoom={16} fitView fitViewOptions={{ padding: 0.2, minZoom: 0.25, maxZoom: 1.5 }} onInit={instance => { flowInstance.current = instance; if (activeMatch) focusSearchMatch(activeMatch) }} onNodeClick={(_, node) => setSelected(node.data.trace)}>
        <MiniMap nodeColor={node => MINIMAP_COLORS[node.data?.palette] || MINIMAP_COLORS.slate} />
        <Controls />
        <Background />
      </ReactFlow>
      {visibleNodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">No meaningful execution nodes available for the selected filters.</div>}
    </div>
    {selected && <aside className="absolute z-20 right-0 top-0 h-full w-96 bg-slate-800 border-l border-slate-600 p-4 overflow-auto shadow-2xl">
      <button className="float-right text-slate-300 hover:text-white" onClick={() => setSelected(null)} aria-label="Close details">×</button>
      <h3 className="text-slate-100 font-semibold pr-8">{selected.title}</h3>
      {selected.type === 'input' && selected.details?.prompt && <section className="mt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-orange-300">User prompt</h4>
        <pre className="mt-2 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded border border-slate-600 bg-slate-900/70 p-3 text-sm leading-relaxed text-slate-200">{selected.details.prompt}</pre>
      </section>}
      <TraceDetailsPanel selected={selected} payloadLoading={payloadLoading} onLoadPayload={loadSelectedPayload} />
      {selected.type === 'output' && <button className="mt-3 px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-xs" disabled={payloadLoading || !selected.details?.payload_available} onClick={loadSelectedPayload}>{payloadLoading ? 'Loading…' : 'Load payload'}</button>}
      {(selected.type === 'agent_attempt' && firstCallId) && <AgentInvocationInspector callId={firstCallId} rounds={rounds} onClose={() => setSelected(null)} />}
      {selected.type === 'llm_call' && selected.details?.call_id && <AgentInvocationInspector callId={selected.details.call_id} rounds={[{ callId: selected.details.call_id, turnIndex: selected.details.turn_index }]} onClose={() => setSelected(null)} />}
      {['result', 'output'].includes(selected.type) && (selected.details?.output_source || selected.details?.result_source) === 'not_recorded' && <p className="mt-3 text-xs text-slate-400">{selected.type === 'output' ? 'Output' : 'Result'} was not recorded by the available execution history.</p>}
      {['result', 'output'].includes(selected.type) && selected.details?.artifact_path && <p className="mt-3 text-xs text-slate-300">Artifact: <span className="font-mono">{selected.details.artifact_path}</span></p>}
      {['result', 'output'].includes(selected.type) && selected.details?.deployment_url && <a className="mt-3 inline-block text-xs text-sky-300 hover:text-sky-200 underline" href={selected.details.deployment_url} target="_blank" rel="noreferrer">Open deployment</a>}
      {!['tool', 'tool_call', 'tool_result', 'result'].includes(selected.type) && <pre className="text-xs text-slate-300 whitespace-pre-wrap mt-3">{JSON.stringify(selected.details || {}, null, 2)}</pre>}
    </aside>}
  </div>
}
