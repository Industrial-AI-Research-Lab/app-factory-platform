import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Save, RefreshCw, Search, ToggleLeft, ToggleRight, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import TopNavLinks from '../components/TopNavLinks'
import InlineImportJson from '../components/InlineImportJson'
import { apiFetch } from '../utils_api'
import { hasWhitespace, isMcpTool } from '../components/mcp/helpers'
import {
  entityDescriptionsForForm,
  entityDescriptionsForSave,
  entityShortDescription,
  SHORT_DESCRIPTION_MAX_LEN,
} from '../utils/entity_descriptions'
import {
  buildToolConfigurationsListQuery,
  resolveCategoryFilter,
} from './toolConfigurationsListQuery'

const TOOL_CATEGORY_UNASSIGNED = '__unassigned__'
const DEFAULT_CREATE_CATEGORY = 'general'

function defaultCreateCategory(categories) {
  const items = Array.isArray(categories) ? categories : []
  if (items.some(c => String(c || '').trim() === DEFAULT_CREATE_CATEGORY)) {
    return DEFAULT_CREATE_CATEGORY
  }
  const firstReal = items
    .map(c => String(c || '').trim())
    .find(c => c && c !== TOOL_CATEGORY_UNASSIGNED)
  return firstReal || DEFAULT_CREATE_CATEGORY
}

function toolCategoryForForm(stored) {
  const trimmed = String(stored ?? '').trim()
  return trimmed || TOOL_CATEGORY_UNASSIGNED
}

function toolCategoryForSave(formCategory) {
  const trimmed = String(formCategory ?? '').trim()
  return trimmed === TOOL_CATEGORY_UNASSIGNED ? '' : trimmed
}

function toolMatchesStatusFilter(tool, statusFilter) {
  const enabled = tool.enabled !== false
  if (statusFilter === 'enabled') return enabled
  if (statusFilter === 'disabled') return !enabled
  return true
}

function emptyForm() {
  return {
    id: '',
    name: '',
    description: '',
    short_description: '',
    long_description: '',
    category: DEFAULT_CREATE_CATEGORY,
    source: 'builtin',
    enabled: true,
    version: '',
  }
}

export default function ToolConfigurations() {
  const [tools, setTools] = useState([])
  const [categories, setCategories] = useState([])
  const [categoriesError, setCategoriesError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState({})
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm())
  const [modalError, setModalError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('')
  const toolsFetchAbortRef = useRef(null)
  const listFiltersRef = useRef({
    searchQuery: debouncedSearchQuery,
    statusFilter,
    categoryFilter,
  })
  const formIdHasSpaces = hasWhitespace(form.id)

  listFiltersRef.current = {
    searchQuery: debouncedSearchQuery,
    statusFilter,
    categoryFilter,
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const categorySuggestions = useMemo(() => {
    const set = new Set(categories)
    set.add(DEFAULT_CREATE_CATEGORY)
    const current = (form.category || '').trim()
    if (current) set.add(current)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [categories, form.category])

  useEffect(() => {
    if (!showCreate || editingId) return
    setForm(f => {
      if ((f.category || '').trim()) return f
      return { ...f, category: defaultCreateCategory(categories) }
    })
  }, [categories, showCreate, editingId])

  const fetchCategories = useCallback(async () => {
    try {
      const res = await apiFetch('/configurations/tools/categories/')
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `Categories request failed (${res.status})`)
      }
      const data = await res.json()
      const items = Array.isArray(data.items) ? data.items : []
      setCategories(items)
      setCategoriesError(null)
      // Drop stale filter so refreshAll → fetchTools does not query a dead category.
      const nextFilter = resolveCategoryFilter(listFiltersRef.current.categoryFilter, items)
      listFiltersRef.current.categoryFilter = nextFilter
      setCategoryFilter(prev => (prev === nextFilter ? prev : nextFilter))
    } catch (err) {
      setCategoriesError(err.message)
    }
  }, [])

  const fetchTools = useCallback(async () => {
    toolsFetchAbortRef.current?.abort()
    const controller = new AbortController()
    toolsFetchAbortRef.current = controller
    const { signal } = controller
    const { searchQuery, statusFilter: status, categoryFilter: category } = listFiltersRef.current

    setLoading(true)
    setError(null)
    try {
      const path = buildToolConfigurationsListQuery({
        searchQuery,
        statusFilter: status,
        categoryFilter: category,
      })
      const res = await apiFetch(path, { signal })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `Tools request failed (${res.status})`)
      }
      const data = await res.json()
      if (signal.aborted) return
      setTools((data || []).filter(t => !isMcpTool(t)))
    } catch (err) {
      if (err.name === 'AbortError') return
      if (!signal.aborted) setError(err.message)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [])

  // Categories first so a pruned categoryFilter is visible to fetchTools via listFiltersRef.
  const refreshAll = useCallback(async () => {
    await fetchCategories()
    await fetchTools()
  }, [fetchCategories, fetchTools])

  useEffect(() => { fetchCategories() }, [fetchCategories])

  useEffect(() => {
    fetchTools()
    return () => toolsFetchAbortRef.current?.abort()
  }, [debouncedSearchQuery, statusFilter, categoryFilter, fetchTools])

  useEffect(() => () => toolsFetchAbortRef.current?.abort(), [])

  const applyToolRowUpdate = (updated) => {
    const updatedId = updated?.id || updated?._id
    if (!updatedId) return
    setTools(prev => prev.map(t => {
      const rowId = t.id || t._id
      return rowId === updatedId ? updated : t
    }))
  }

  const toggleEnabled = async (tool) => {
    const id = tool.id || tool._id
    setSaving(prev => ({ ...prev, [id]: true }))
    try {
      const res = await apiFetch(`/configurations/tools/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !tool.enabled }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Update failed') }
      const updated = await res.json()
      const { statusFilter } = listFiltersRef.current
      if (toolMatchesStatusFilter(updated, statusFilter)) {
        applyToolRowUpdate(updated)
      } else {
        setTools(prev => prev.filter(t => (t.id || t._id) !== id))
      }
    } catch (err) {
      alert(`Toggle failed: ${err.message}`)
      return
    } finally {
      setSaving(prev => ({ ...prev, [id]: false }))
    }
    await fetchTools()
  }

  const openEdit = (tool) => {
    const id = tool.id || tool._id
    setEditingId(id)
    setForm({
      id,
      name: tool.name || '',
      ...entityDescriptionsForForm(tool),
      category: toolCategoryForForm(tool.category),
      source: 'builtin',
      enabled: tool.enabled !== false,
      version: tool.version || '',
    })
    setShowCreate(false)
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({ ...emptyForm(), category: defaultCreateCategory(categories) })
    setShowCreate(true)
  }

  const closeModal = () => {
    setShowCreate(false)
    setEditingId(null)
    setModalError(null)
  }

  const saveTool = async () => {
    setModalError(null)
    if (formIdHasSpaces) {
      setModalError({ message: 'Tool ID cannot contain spaces. Use "-" or "_".' })
      return
    }
    const body = {
      ...form,
      ...entityDescriptionsForSave(form),
      source: 'builtin',
      category: toolCategoryForSave(form.category),
    }
    const id = editingId || form.id
    setSaving(prev => ({ ...prev, modal: true }))
    try {
      let res
      if (editingId) {
        const { id: _id, ...updateBody } = body
        res = await apiFetch(`/configurations/tools/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody),
        })
      } else {
        res = await apiFetch('/configurations/tools/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      if (!res.ok) {
        const e = await res.json()
        const detail = e.detail
        if (detail && typeof detail === 'object' && detail.code === 'name_conflict') {
          setModalError(detail)
          return
        }
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
      }
      closeModal()
      await refreshAll()
    } catch (err) {
      setModalError({ message: `Save failed: ${err.message}` })
    } finally {
      setSaving(prev => ({ ...prev, modal: false }))
    }
  }

  const deleteTool = async (tool) => {
    const id = tool.id || tool._id
    if (!confirm(`Delete tool "${tool.name || id}"?`)) return
    try {
      const res = await apiFetch(`/configurations/tools/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const e = await res.json()
        throw new Error(e.detail || 'Delete failed')
      }
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
      return
    }
    setTools(prev => prev.filter(t => (t.id || t._id) !== id))
    await refreshAll()
  }

  const clearListFilters = () => {
    setSearchQuery('')
    setDebouncedSearchQuery('')
    setStatusFilter('all')
    setCategoryFilter('')
  }

  const listFiltersActive = Boolean(
    searchQuery.trim() || statusFilter !== 'all' || categoryFilter,
  )

  const canSaveForm = !saving.modal && !formIdHasSpaces && Boolean((form.category || '').trim())

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">Tool Configurations</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-xl font-bold shrink-0">Tools</h1>
            <p className="text-xs text-slate-500 mt-1">
              Built-in tools only.{' '}
              <Link to="/configurations/mcp-tools" className="text-purple-400 hover:text-purple-300">
                Manage MCP tools
              </Link>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <div className="relative w-44 max-w-full">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="w-full bg-slate-700 border border-slate-600 rounded pl-8 pr-2 py-1.5 text-xs"
              />
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs"
              aria-label="Status filter"
            >
              <option value="all">All statuses</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs max-w-[12rem]"
              aria-label="Category filter"
            >
              <option value="">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {listFiltersActive && (
              <button
                type="button"
                onClick={clearListFilters}
                className="px-2 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                Clear filters
              </button>
            )}
            <button
              type="button"
              onClick={refreshAll}
              className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <InlineImportJson kind="tools" onImported={refreshAll} />
            <button
              type="button"
              onClick={openCreate}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> New Tool
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">{error}</div>
        )}
        {categoriesError && (
          <div className="bg-amber-900/40 border border-amber-700 text-amber-100 px-4 py-2 rounded mb-4 text-sm">
            Could not load tool categories: {categoriesError}
          </div>
        )}
        {loading && <div className="text-slate-400 text-sm">Loading...</div>}

        <div
          className={`bg-slate-800 border border-slate-700 rounded-lg overflow-x-auto overflow-y-hidden${loading ? ' opacity-60' : ''}`}
          aria-busy={loading || undefined}
        >
          <table className="w-full min-w-[800px] text-sm">
            <thead>
              <tr className="text-xs text-slate-400 border-b border-slate-700">
                <th className="text-left px-4 py-2">ID</th>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Summary</th>
                <th className="text-left px-4 py-2">Category</th>
                <th className="text-left px-4 py-2">Version</th>
                <th className="text-left px-4 py-2">Source</th>
                <th className="text-center px-4 py-2">Enabled</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tools.map(tool => {
                const id = tool.id || tool._id
                return (
                  <tr key={id} className="border-b border-slate-700/50 hover:bg-slate-750">
                    <td className="px-4 py-2 font-mono text-xs">{id}</td>
                    <td className="px-4 py-2">{tool.name}</td>
                    <td className="px-4 py-2 text-slate-400 text-xs max-w-[200px] truncate">{entityShortDescription(tool) || '—'}</td>
                    <td className="px-4 py-2">
                      <span className="text-xs bg-slate-700 px-2 py-0.5 rounded">{toolCategoryForForm(tool.category)}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">{tool.version || '—'}</td>
                    <td className="px-4 py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">{tool.source}</span>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => toggleEnabled(tool)}
                        disabled={loading || saving[id]}
                        className="inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {tool.enabled
                          ? <ToggleRight className="w-5 h-5 text-green-400" />
                          : <ToggleLeft className="w-5 h-5 text-slate-500" />}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2 min-w-[110px]">
                        <button
                          type="button"
                          onClick={() => openEdit(tool)}
                          disabled={loading}
                          className="px-2 py-1 text-xs text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteTool(tool)}
                          disabled={loading}
                          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!loading && !error && tools.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No built-in tools found.</td></tr>
              )}
              {!loading && error && tools.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">Failed to load tools.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {(showCreate || editingId) && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-2 overflow-y-auto">
          <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-2xl p-6 my-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editingId ? 'Edit Tool' : 'New Tool'}</h2>
              <button type="button" onClick={closeModal}><X className="w-5 h-5 text-slate-400 hover:text-white" /></button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-slate-400">ID</span>
                <input
                  type="text"
                  value={form.id}
                  disabled={!!editingId}
                  onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
                  className={`w-full bg-slate-700 border rounded px-2 py-1.5 text-sm mt-1 disabled:opacity-50 ${
                    formIdHasSpaces ? 'border-red-500' : 'border-slate-600'
                  }`}
                />
                {formIdHasSpaces && (
                  <p className="mt-1 text-xs text-red-300">Tool ID cannot contain spaces. Use &quot;-&quot; or &quot;_&quot;.</p>
                )}
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Name</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setModalError(null) }}
                  className={`w-full bg-slate-700 border rounded px-2 py-1.5 text-sm mt-1 ${
                    modalError?.code === 'name_conflict' ? 'border-amber-500' : 'border-slate-600'
                  }`}
                />
              </label>
              {modalError && (
                <div className="bg-red-900/40 border border-red-700 text-red-200 rounded px-3 py-2 text-xs space-y-1.5">
                  <p>{modalError.message}</p>
                  {modalError.code === 'name_conflict' && modalError.suggested_name && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-slate-400">Suggested name:</span>
                      <code className="bg-slate-700 px-1.5 py-0.5 rounded font-mono">{modalError.suggested_name}</code>
                      <button
                        type="button"
                        onClick={() => { setForm(f => ({ ...f, name: modalError.suggested_name })); setModalError(null) }}
                        className="px-2 py-0.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs"
                      >
                        Use this name
                      </button>
                    </div>
                  )}
                </div>
              )}
              <label className="block">
                <span className="text-xs text-slate-400">Short description</span>
                <input
                  type="text"
                  maxLength={SHORT_DESCRIPTION_MAX_LEN}
                  value={form.short_description}
                  onChange={e => setForm(f => ({ ...f, short_description: e.target.value }))}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Long description</span>
                <textarea
                  value={form.long_description}
                  onChange={e => setForm(f => ({ ...f, long_description: e.target.value }))}
                  placeholder="Optional details"
                  rows={3}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Category</span>
                <input
                  type="text"
                  list="tool-category-suggestions"
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  placeholder={DEFAULT_CREATE_CATEGORY}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                />
                <datalist id="tool-category-suggestions">
                  {categorySuggestions.map(c => <option key={c} value={c} />)}
                </datalist>
                <p className="mt-1 text-xs text-slate-500">
                  Pick from the dictionary or type a new category name.
                </p>
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Version</span>
                <input
                  type="text"
                  maxLength={32}
                  value={form.version}
                  onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
                  placeholder="e.g. 1.0.0"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                />
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                  className="accent-blue-500"
                />
                <span className="text-sm">Enabled</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={closeModal} className="px-4 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded">Cancel</button>
              <button
                type="button"
                onClick={saveTool}
                disabled={!canSaveForm}
                className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" /> {saving.modal ? 'Saving...' : editingId ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
