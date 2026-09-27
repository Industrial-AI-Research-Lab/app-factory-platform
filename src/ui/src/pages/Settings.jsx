import { useEffect, useState, useRef, useMemo } from 'react'
import { RefreshCw, Search, Check, Clock, Zap, Play, AlertCircle, Brain } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import { apiFetch } from '../utils_api'
import { useModels } from '../hooks/useModels'

export default function Settings() {
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)

  // Models metadata state (stale / updated_at / rate-limit — берём из хука)
  const [refreshing, setRefreshing] = useState(false)
  const [rateLimited, setRateLimited] = useState(false)
  const [minutesUntilRefresh, setMinutesUntilRefresh] = useState(0)

  // Default model state
  const [defaultModel, setDefaultModel] = useState(null)
  const [defaultModelName, setDefaultModelName] = useState(null)
  const [defaultModelSaved, setDefaultModelSaved] = useState(false)

  // Test model state
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  // Search/filter state — передаём в useModels, бэкенд применяет их сам
  const [searchQuery, setSearchQuery] = useState('')
  const [reasoningOnly, setReasoningOnly] = useState(false)

  // ── Backend-driven model search ───────────────────────────────────────
  const {
    models,
    loading: modelsLoading,
    loadingMore,
    error: modelsError,
    hasMore,
    fetchMore,
    reset: resetModels,
    filteredCount,
    totalCount,
    updatedAt: modelsUpdatedAt,
    stale: modelsStale,
    maxPriceFilter,
  } = useModels({
    q: searchQuery,
    reasoning: reasoningOnly ? true : undefined,
    limit: 50,
  })

  // Sentinel для инфинити-лоада в скролл-контейнере списка
  const sentinelRef = useRef(null)
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
    const existing = localStorage.getItem('OPENAI_API_KEY') || ''
    setKey(existing)
    fetchDefaultModel()
  }, [])

  const fetchDefaultModel = async () => {
    try {
      const res = await apiFetch('/settings/default-model')
      const data = await res.json()
      setDefaultModel(data.model_id)
      setDefaultModelName(data.model_name)
    } catch (err) {
      console.error('Failed to fetch default model:', err)
    }
  }

  const testModel = async (withReasoning = false, effort = 'medium') => {
    if (!defaultModel) return
    setTesting(true)
    setTestResult(null)
    try {
      const params = new URLSearchParams({
        model_id: defaultModel,
        reasoning: withReasoning.toString(),
        effort: effort
      })
      const res = await apiFetch(`/settings/test-model?${params}`, {
        method: 'POST'
      })
      const data = await res.json()
      setTestResult({ ...data, reasoning_used: withReasoning })
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setTesting(false)
    }
  }

  // Check if current model supports reasoning.
  // Сначала ищем в уже загруженном списке; если модель там не нашлась
  // (например, она за пределами первых 50 по текущим фильтрам) — делаем
  // точечный запрос по точному id, чтобы не потерять reasoning-кнопки.
  const [defaultModelMeta, setDefaultModelMeta] = useState(null)

  useEffect(() => {
    if (!defaultModel) { setDefaultModelMeta(null); return }
    const found = models.find(m => m.id === defaultModel)
    if (found) { setDefaultModelMeta(found); return }
    // Модель не в текущем батче — точечный запрос
    apiFetch(`/settings/models?q=${encodeURIComponent(defaultModel)}&limit=5`)
      .then(r => r.json())
      .then(data => {
        const exact = (data.models || []).find(m => m.id === defaultModel)
        if (exact) setDefaultModelMeta(exact)
      })
      .catch(() => {})
  }, [defaultModel, models])

  const currentModelSupportsReasoning = !!defaultModelMeta?.is_reasoning

  const refreshModels = async () => {
    setRefreshing(true)
    setRateLimited(false)
    try {
      const res = await apiFetch('/settings/models/refresh', { method: 'POST' })
      const data = await res.json()
      if (data.rate_limited) {
        setRateLimited(true)
        setMinutesUntilRefresh(data.minutes_until_refresh || 0)
      }
      // После refresh сбрасываем хук чтобы он перезапросил свежий кэш
      resetModels()
    } catch (err) {
      console.error('Refresh failed:', err)
    } finally {
      setRefreshing(false)
    }
  }

  const saveDefaultModel = async (modelId) => {
    const model = models.find(m => m.id === modelId)
    try {
      const res = await apiFetch(`/settings/default-model?model_id=${encodeURIComponent(modelId)}&model_name=${encodeURIComponent(model?.name || '')}`, {
        method: 'PUT'
      })
      if (res.ok) {
        setDefaultModel(modelId)
        setDefaultModelName(model?.name || null)
        setDefaultModelSaved(true)
        setTestResult(null) // Clear test result when model changes
        setTimeout(() => setDefaultModelSaved(false), 1500)
      }
    } catch (err) {
      console.error('Failed to save default model:', err)
    }
  }

  const save = () => {
    if (!key) {
      localStorage.removeItem('OPENAI_API_KEY')
    } else {
      localStorage.setItem('OPENAI_API_KEY', key)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const clear = () => {
    setKey('')
    localStorage.removeItem('OPENAI_API_KEY')
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  // Группируем модели по полю provider (бэкенд уже добавил его).
  // Порядок групп — порядок первого появления в отсортированном списке.
  const groupedModels = useMemo(() => {
    const groups = {}
    const order = []
    models.forEach(model => {
      const provider = model.provider || model.id?.split('/')[0] || 'other'
      if (!groups[provider]) {
        groups[provider] = []
        order.push(provider)
      }
      groups[provider].push(model)
    })
    return order.map(provider => [provider, groups[provider]])
  }, [models])

  const formatPrice = (model) => {
    if (model.is_free) return { text: 'Free', isFree: true }
    const input = model.input_price || 0
    const output = model.output_price || 0
    return {
      text: `$${input.toFixed(2)} / $${output.toFixed(2)}`,
      isFree: false,
      input,
      output
    }
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="px-8 py-6 border-b border-slate-800">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold text-slate-100">Settings</h1>
          <TopNavLinks />
        </div>
      </div>
      <div className="max-w-4xl mx-auto p-8 space-y-8">
        {/* Default Model Selection */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Default Model</h2>
            <div className="flex items-center gap-2">
              {modelsUpdatedAt && (
                <span className="text-xs text-slate-500">
                  Updated: {new Date(modelsUpdatedAt).toLocaleString()}
                  {modelsStale && <span className="text-yellow-500 ml-1">(stale)</span>}
                </span>
              )}
              <button
                onClick={refreshModels}
                disabled={refreshing}
                className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 px-3 py-1.5 rounded-lg text-sm"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh Models
              </button>
            </div>
          </div>

          {rateLimited && (
            <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-700 rounded-lg text-yellow-300 text-sm flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Rate limited. Can refresh again in {minutesUntilRefresh} minutes.
            </div>
          )}

          {/* Current Default Model */}
          {defaultModel && (
            <div className="mb-4 p-4 bg-slate-900 border border-slate-600 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Current Default</div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-100 font-medium">{defaultModelName || defaultModel}</span>
                    {currentModelSupportsReasoning && (
                      <Brain className="w-4 h-4 text-purple-400" title="Supports reasoning" />
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{defaultModel}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => testModel(false)}
                    disabled={testing}
                    className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm"
                  >
                    <Play className={`w-4 h-4 ${testing ? 'animate-pulse' : ''}`} />
                    {testing ? 'Testing...' : 'Test'}
                  </button>
                  {currentModelSupportsReasoning && (
                    <button
                      onClick={() => testModel(true, 'medium')}
                      disabled={testing}
                      className="flex items-center gap-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm"
                      title="Test with reasoning enabled"
                    >
                      <Brain className={`w-4 h-4 ${testing ? 'animate-pulse' : ''}`} />
                      {testing ? 'Testing...' : 'Test + Reasoning'}
                    </button>
                  )}
                </div>
              </div>

              {/* Test Result */}
              {testResult && (
                <div className={`mt-3 p-3 rounded-lg text-sm ${testResult.success ? 'bg-green-900/30 border border-green-700' : 'bg-red-900/30 border border-red-700'}`}>
                  {testResult.success ? (
                    <div>
                      <div className="flex items-center gap-2 text-green-300 mb-2">
                        <Check className="w-4 h-4" />
                        <span className="font-medium">Success</span>
                        {testResult.reasoning_used && <span className="text-purple-300 text-xs">(reasoning)</span>}
                        <span className="text-green-400/70">• {testResult.latency_ms}ms</span>
                        <span className="text-green-400/70">• {testResult.tokens?.total || 0} tokens</span>
                      </div>
                      {testResult.response ? (
                        <div className="text-slate-300 bg-slate-800 p-2 rounded text-xs font-mono whitespace-pre-wrap">{testResult.response}</div>
                      ) : (
                        <div className="text-slate-500 bg-slate-800 p-2 rounded text-xs italic">No response content (model may have returned empty)</div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-red-300">
                      <AlertCircle className="w-4 h-4" />
                      <span>{testResult.error}</span>
                      {testResult.latency_ms && <span className="text-red-400/70">• {testResult.latency_ms}ms</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <p className="text-slate-400 mb-4">
            Select the default LLM model for new projects. Models are fetched from OpenRouter.
            {maxPriceFilter && (
              <span className="text-yellow-400 ml-1">
                (filtered to ≤${maxPriceFilter}/1M tokens)
              </span>
            )}
          </p>

          {/* Search + Filter — параметры уходят на бэкенд через useModels */}
          <div className="flex gap-2 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={() => setReasoningOnly(!reasoningOnly)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors ${
                reasoningOnly
                  ? 'bg-purple-900/40 border-purple-600 text-purple-300'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
              }`}
              title="Filter to reasoning models only"
            >
              <Brain className="w-4 h-4" />
              {reasoningOnly ? 'Reasoning only' : '🧠 Reasoning'}
            </button>
          </div>

          {modelsLoading ? (
            <div className="text-slate-400 py-8 text-center">Loading models...</div>
          ) : modelsError ? (
            <div className="text-red-400 py-4">{modelsError}</div>
          ) : models.length === 0 ? (
            <div className="text-slate-400 py-8 text-center">
              {searchQuery || reasoningOnly
                ? 'No models match your filters.'
                : 'No models cached. Click "Refresh Models" to fetch from OpenRouter.'}
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-4 pr-2">
              {groupedModels.map(([provider, providerModels]) => (
                <div key={provider}>
                  <h3 className="text-sm font-medium text-slate-400 mb-2 capitalize sticky top-0 bg-slate-800 py-1">
                    {provider} ({providerModels.length})
                  </h3>
                  <div className="space-y-1">
                    {providerModels.map(model => (
                      <button
                        key={model.id}
                        onClick={() => saveDefaultModel(model.id)}
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${
                          defaultModel === model.id
                            ? 'bg-blue-900/40 border-blue-600 text-blue-100'
                            : 'bg-slate-900 border-slate-700 hover:border-slate-600 text-slate-200'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{model.name}</span>
                              {model.is_reasoning && (
                                <Brain className="w-4 h-4 text-purple-400 flex-shrink-0" title="Reasoning model" />
                              )}
                              {defaultModel === model.id && (
                                <Check className="w-4 h-4 text-blue-400 flex-shrink-0" />
                              )}
                            </div>
                            <div className="text-xs text-slate-500 truncate">{model.id}</div>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-400 flex-shrink-0 ml-2">
                            {model.context_length && (
                              <span>{(model.context_length / 1000).toFixed(0)}k ctx</span>
                            )}
                            {(() => {
                              const price = formatPrice(model)
                              return (
                                <span className={price.isFree ? 'text-green-400' : ''} title="Input / Output per 1M tokens">
                                  {price.isFree && <Zap className="w-3 h-3 inline mr-0.5" />}
                                  {price.text}
                                </span>
                              )
                            })()}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {/* Sentinel для инфинити-лоада */}
              {hasMore && (
                <div ref={sentinelRef} className="py-3 text-center">
                  {loadingMore
                    ? <span className="text-xs text-slate-400">Loading more models…</span>
                    : <span className="text-xs text-slate-500">Scroll to load more</span>
                  }
                </div>
              )}
            </div>
          )}

          {defaultModelSaved && (
            <div className="mt-3 text-sm text-green-400 flex items-center gap-1">
              <Check className="w-4 h-4" /> Default model saved
            </div>
          )}

          <div className="mt-4 text-xs text-slate-500">
            Total models: {totalCount} | Matching filters: {filteredCount} | Loaded: {models.length}
          </div>
        </div>

        {/* OpenAI API Key */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
          <h2 className="text-lg font-semibold text-slate-100 mb-4">OpenAI API</h2>
          <p className="text-slate-400 mb-6">The OpenAI API key stored here is kept in your browser's localStorage and is sent with each request to the backend. It takes priority over any server-side key.</p>

          <label className="block text-sm text-slate-300 mb-2" htmlFor="openai">OpenAI API Key</label>
          <input
            id="openai"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <div className="flex gap-2 mt-4">
            <button onClick={save} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg">Save</button>
            <button onClick={clear} className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2 rounded-lg">Clear</button>
            {saved && <span className="text-xs text-green-400 self-center">Saved</span>}
          </div>

          <div className="mt-6 text-xs text-slate-500">
            Tip: The key is not sent for SSE connections, but that's fine; only API calls that perform LLM work require it.
          </div>
        </div>
      </div>
    </div>
  )
}