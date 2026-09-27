import { useState, useMemo } from 'react'
import { Activity, Clipboard, Download, Brain, ChevronDown, ChevronRight } from 'lucide-react'
import EventCard from '../EventCard'
import EventFilterBar from './EventFilterBar'
import { notify } from '../../utils_notify'
import {
  eventsForLogExport,
  filterEventsForDisplay,
} from '../../utils/eventLogFilter'
import useEventFilter from '../../hooks/useEventFilter'
import useAgentModels from '../../hooks/useAgentModels'
import useConfigAddresses from '../../hooks/useConfigAddresses'
import { DEFAULT_FACETS } from '../../utils/eventFacets'

const LEVEL_KEY = 'AppFactory.eventsTab.level'
const emptySelection = () => Object.fromEntries(DEFAULT_FACETS.map((f) => [f.key, new Set()]))

/**
 * Collapsed Thought Card - shows thinking content when expanded
 */
function ThoughtCard({ thought, index }) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  const rawTime = thought.thinkingTime || 0
  const formattedTime = typeof rawTime === 'number' ? rawTime.toFixed(1) : rawTime
  const timeLabel = rawTime > 0
    ? `Thought for ${formattedTime}s` 
    : 'Thinking...'
  
  return (
    <div className="rounded-lg border border-purple-700/50 bg-purple-900/20 overflow-hidden">
      <div 
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-purple-800/20 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="text-purple-400">
          <Brain className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-purple-200">
              {timeLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-slate-500">#{index + 1}</span>
            <span className="text-xs text-slate-500">•</span>
            <span className="text-xs text-slate-400">
              Round {thought.round}
            </span>
          </div>
        </div>
        <button className="text-slate-400 hover:text-slate-300 flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>
      </div>
      
      {isExpanded && (
        <div className="border-t border-purple-700/50 bg-slate-900/50 p-4">
          <div className="text-xs font-medium text-purple-300 mb-2">Thinking Content:</div>
          <div className="text-sm text-slate-300 whitespace-pre-wrap font-mono bg-slate-950 p-3 rounded max-h-96 overflow-y-auto">
            {thought.content || '(empty)'}
          </div>
        </div>
      )}
    </div>
  )
}

export default function EventsTab({ events, project, projectId, onStopAndRevertPreviousUserAction }) {
  const displayEvents = useMemo(() => filterEventsForDisplay(events), [events])
  const displayCount = displayEvents.length

  const runId = project?.current_run_id || project?.run_id
  const modelIndex = useAgentModels(projectId, runId)
  const configMaps = useConfigAddresses()

  const [level, setLevel] = useState(() => {
    try { return localStorage.getItem(LEVEL_KEY) === 'raw' ? 'raw' : 'signal' } catch { return 'signal' }
  })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(emptySelection)

  const { annotated, filtered, counts, teleHidden } = useEventFilter(displayEvents, { level, query, selected, modelIndex, configMaps })

  const changeLevel = (next) => {
    setLevel(next)
    try { localStorage.setItem(LEVEL_KEY, next) } catch { /* private mode / blocked storage */ }
  }
  const toggleFacet = (key, value) => setSelected((prev) => {
    const set = new Set(prev[key])
    if (set.has(value)) set.delete(value)
    else set.add(value)
    return { ...prev, [key]: set }
  })
  const clearFacet = (key) => setSelected((prev) => ({ ...prev, [key]: new Set() }))
  const clearAll = () => { setQuery(''); setSelected(emptySelection()) }
  const hasActiveFilters = Boolean(query.trim()) || DEFAULT_FACETS.some((f) => (selected[f.key]?.size || 0) > 0)

  const copyAllEventsAsJson = async () => {
    if (displayCount === 0) return
    try {
      const jsonString = JSON.stringify(eventsForLogExport(events), null, 2)
      await navigator.clipboard.writeText(jsonString)
      notify({
        title: 'Copied',
        message: `Copied ${displayCount} events as JSON`,
        variant: 'success',
        ttl: 2500,
      })
    } catch (error) {
      console.error('Failed to copy events:', error)
      notify({ title: 'Copy failed', message: String(error), variant: 'error', ttl: 6000 })
    }
  }

  const downloadAllEventsAsJson = () => {
    if (events.length === 0) return
    try {
      const jsonString = JSON.stringify(events, null, 2)
      const blob = new Blob([jsonString], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project?.name || 'project'}-events-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to download events:', error)
      notify({ title: 'Download failed', message: String(error), variant: 'error', ttl: 6000 })
    }
  }

  return (
    <div>
      {displayCount > 0 && (
        <div className="flex justify-between items-center mb-4 bg-slate-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-slate-100">Event Log ({displayCount})</h3>
          <div className="flex gap-2">
            <button
              onClick={copyAllEventsAsJson}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded-lg transition-colors"
            >
              <Clipboard className="w-4 h-4" /> Copy as JSON
            </button>
            <button
              onClick={downloadAllEventsAsJson}
              className="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg transition-colors"
            >
              <Download className="w-4 h-4" /> Download JSON
            </button>
          </div>
        </div>
      )}
      {displayCount > 0 && (
        <EventFilterBar
          level={level}
          onLevelChange={changeLevel}
          query={query}
          onQueryChange={setQuery}
          facets={DEFAULT_FACETS}
          counts={counts}
          selected={selected}
          onToggle={toggleFacet}
          onClearFacet={clearFacet}
          onClearAll={clearAll}
          teleHidden={teleHidden}
          shown={filtered.length}
          total={annotated.length}
        />
      )}
      <div className="space-y-2 max-h-[700px] overflow-y-auto pr-2">
        {annotated.length === 0 ? (
          <div className="bg-slate-800 rounded-lg p-8 text-center">
            <Activity className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">Waiting for events...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-slate-800 rounded-lg p-8 text-center">
            <Activity className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            {hasActiveFilters ? (
              <>
                <p className="text-slate-400">No events match these filters.</p>
                <button onClick={clearAll} className="mt-3 text-sm text-blue-400 hover:underline">
                  Clear all filters
                </button>
              </>
            ) : teleHidden > 0 ? (
              <>
                <p className="text-slate-400">Every event so far is telemetry, hidden in Signal view.</p>
                <button onClick={() => changeLevel('raw')} className="mt-3 text-sm text-blue-400 hover:underline">
                  Show all
                </button>
              </>
            ) : (
              <p className="text-slate-400">No events to show.</p>
            )}
          </div>
        ) : (
          filtered.map((item, idx) => (
            item.type === 'collapsed_thought' ? (
              <ThoughtCard
                key={`thought-${item.originalIndex ?? idx}`}
                thought={item}
                index={idx}
              />
            ) : (
              <EventCard
                key={item.originalIndex ?? idx}
                event={item}
                index={item.originalIndex ?? idx}
                allEvents={events}
                onRevertToLastUserAction={onStopAndRevertPreviousUserAction}
              />
            )
          ))
        )}
      </div>
    </div>
  )
}
