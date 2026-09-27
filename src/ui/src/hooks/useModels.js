import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../utils_api'

const DEFAULT_LIMIT = 50

export function useModels({
  q,
  provider,
  reasoning,
  free,
  minInputPrice,
  maxInputPrice,
  minOutputPrice,
  maxOutputPrice,
  sortBy,
  sortDir = 'asc',
  limit = DEFAULT_LIMIT,
  enabled = true,
} = {}) {
  const [models, setModels] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const [meta, setMeta] = useState({
    totalCount: 0,
    filteredCount: 0,
    availableProviders: [],
    updatedAt: null,
    stale: false,
    maxPriceFilter: null,
  })

  const providerKey = Array.isArray(provider) ? provider.join(',') : (provider || '')

  // ── Все параметры в ref — buildParams читает их в момент вызова ──────
  // Это разрывает цепочку: параметр изменился → buildParams пересоздался
  // → doFetch пересоздался → эффект сработал немедленно.
  // Теперь doFetch стабилен, а эффект триггерится только через paramsVersion.
  const paramsRef = useRef({})
  paramsRef.current = { q, providerKey, reasoning, free, minInputPrice, maxInputPrice, minOutputPrice, maxOutputPrice, sortBy, sortDir, limit }

  // ── paramsVersion — единственный триггер перезапроса ────────────────
  // Инкрементируется когда реально меняется хоть один параметр.
  const [paramsVersion, setParamsVersion] = useState(0)

  // Сериализуем параметры для сравнения
  const paramsKey = [q, providerKey, String(reasoning), String(free), minInputPrice, maxInputPrice, minOutputPrice, maxOutputPrice, sortBy, sortDir, limit].join('|')
  const prevParamsKeyRef = useRef(paramsKey)

  useEffect(() => {
    if (paramsKey !== prevParamsKeyRef.current) {
      prevParamsKeyRef.current = paramsKey
      setParamsVersion(v => v + 1)
    }
  }, [paramsKey])

  // ── AbortController ref ──────────────────────────────────────────────
  const abortRef = useRef(null)

  // ── buildParams читает из ref — стабильная функция ───────────────────
  const buildParams = useCallback((currentOffset) => {
    const p = new URLSearchParams()
    const { q, providerKey, reasoning, free, minInputPrice, maxInputPrice, minOutputPrice, maxOutputPrice, sortBy, sortDir, limit } = paramsRef.current

    if (q)           p.set('q', q)
    if (providerKey) providerKey.split(',').forEach(pr => p.append('provider', pr))
    if (reasoning != null)      p.set('reasoning', String(reasoning))
    if (free != null)           p.set('free', String(free))
    if (minInputPrice != null)  p.set('min_input_price', minInputPrice)
    if (maxInputPrice != null)  p.set('max_input_price', maxInputPrice)
    if (minOutputPrice != null) p.set('min_output_price', minOutputPrice)
    if (maxOutputPrice != null) p.set('max_output_price', maxOutputPrice)
    if (sortBy)      p.set('sort_by', sortBy)
    if (sortDir)     p.set('sort_dir', sortDir)
    p.set('offset', currentOffset)
    p.set('limit', limit)
    return p.toString()
  }, []) // ← намеренно пустой массив, читает через ref

  // ── doFetch стабилен — не пересоздаётся при смене параметров ────────
  const doFetch = useCallback(async (currentOffset, isInitial, signal) => {
    if (isInitial) {
      setLoading(true)
      setError(null)
    } else {
      setLoadingMore(true)
    }

    try {
      const params = buildParams(currentOffset)
      const res = await apiFetch(`/settings/models?${params}`, { signal })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()

      setModels(prev => isInitial ? (data.models || []) : [...prev, ...(data.models || [])])
      setHasMore(data.has_more ?? false)
      setOffset(currentOffset + (data.returned_count ?? 0))
      setMeta({
        totalCount: data.total_count ?? 0,
        filteredCount: data.filtered_count ?? 0,
        availableProviders: data.available_providers ?? [],
        updatedAt: data.updated_at ?? null,
        stale: data.stale ?? false,
        maxPriceFilter: data.max_price_filter ?? null,
      })
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
    } finally {
      if (!signal?.aborted) {
        if (isInitial) setLoading(false)
        else setLoadingMore(false)
      }
    }
  }, [buildParams]) // buildParams стабилен → doFetch тоже стабилен

  // ── Effect: срабатывает только при смене enabled или paramsVersion ───
  // paramsVersion меняется только когда реально изменился хоть один параметр
  // (включая дебаунсированный q из App.jsx).
  // doFetch стабилен — не триггерит этот эффект сам по себе.
  useEffect(() => {
    if (!enabled) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setModels([])
    setOffset(0)
    setHasMore(false)
    doFetch(0, true, controller.signal)

    return () => controller.abort()
  }, [enabled, doFetch, paramsVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  // doFetch стабилен и не будет лишним триггером

  // ── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // ── Fetch more ───────────────────────────────────────────────────────
  const offsetRef = useRef(offset)
  offsetRef.current = offset

  const fetchMore = useCallback(() => {
    // Читаем offset через ref чтобы не пересоздавать fetchMore при каждом изменении offset
    if (!hasMore || loadingMore || loading) return
    const controller = new AbortController()
    abortRef.current = controller
    doFetch(offsetRef.current, false, controller.signal)
  }, [hasMore, loadingMore, loading, doFetch]) // offset убран из deps — читается через ref

  // ── Reset ────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setModels([])
    setOffset(0)
    setHasMore(false)
    doFetch(0, true, controller.signal)
  }, [doFetch])

  return {
    models,
    loading,
    loadingMore,
    error,
    hasMore,
    fetchMore,
    reset,
    ...meta,
  }
}