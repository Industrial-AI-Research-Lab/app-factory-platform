import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle} from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Copy, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import ModelPicker from '../components/ModelPicker'
import { apiFetch, formatApiDetail } from '../utils_api'
import { notify } from '../utils_notify'
import useAuth from '../hooks/useAuth'
import {
  getReasoningControlMode,
  getReasoningEffortOptions,
  getTemperatureControlState,
  resolveRunAgentModel,
} from './agentConfigurationState'
import {
  entityDescriptionsForForm,
  entityDescriptionsForSave,
  entityShortDescription,
  SHORT_DESCRIPTION_MAX_LEN,
} from '../utils/entity_descriptions'

const modelConfigPath = (model) => String(model)
  .split('/')
  .map(encodeURIComponent)
  .join('/')

function emptyRunConfig() {
  return {
    _id: '',
    name: '',
    description: '',
    short_description: '',
    long_description: '',
    is_default: false,
    approval_mode: '',
    models: {},
    agent_configs: {},
    _isNew: true,
  }
}

function normalizeRunConfig(item) {
  return {
    _id: item?._id || '',
    name: item?.name || '',
    ...entityDescriptionsForForm(item),
    is_default: !!item?.is_default,
    approval_mode: item?.approval_mode || '',
    tenant_id: item?.tenant_id || null,
    models: item?.models || {},
    agent_configs: item?.agent_configs || {},
    _isNew: false,
  }
}

function buildCleanAgentConfigs(configs) {
  if (!configs || typeof configs !== 'object') return {}
  const result = {}
  for (const [agentId, cfg] of Object.entries(configs)) {
    const id = agentId?.trim()
    if (!id) continue
    const entry = {}
    if (typeof cfg?.model === 'string' && cfg.model.trim()) entry.model = cfg.model.trim()
    if (cfg?.reasoning_effort) entry.reasoning_effort = cfg.reasoning_effort
    if (typeof cfg?.temperature === 'number') entry.temperature = cfg.temperature
    if (typeof cfg?.step_limit === 'number' && cfg.step_limit >= 1) entry.step_limit = cfg.step_limit
    result[id] = entry
  }
  return result
}

// ─── AddAgentButton ───────────────────────────────────────────────────────────
function AddAgentButton({ suggestions, existing, onAdd }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return suggestions.filter(s => !existing.includes(s) && s.toLowerCase().includes(q))
  }, [suggestions, existing, search])

  useEffect(() => {
    if (!open) { setSearch(''); return }
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleAdd = (id) => {
    const trimmed = id?.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setOpen(false)
    setSearch('')
  }

  const canAddCustom = search.trim() && !filtered.includes(search.trim()) && !existing.includes(search.trim())

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 rounded text-white"
      >
        <Plus className="w-3.5 h-3.5" />
        Add Agent
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 w-64 bg-slate-800 border border-slate-600 rounded-lg shadow-xl">
          <div className="relative border-b border-slate-600">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && search.trim()) handleAdd(search.trim()) }}
              placeholder="Search agents…"
              className="w-full bg-transparent pl-8 pr-3 py-2 text-sm text-slate-200 focus:outline-none"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => handleAdd(s)}
                className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-700"
              >
                {s}
              </button>
            ))}
            {canAddCustom && (
              <button
                type="button"
                onClick={() => handleAdd(search.trim())}
                className="w-full text-left px-3 py-2 text-sm text-blue-300 hover:bg-slate-700 border-t border-slate-700"
              >
                Add &ldquo;{search.trim()}&rdquo;
              </button>
            )}
            {filtered.length === 0 && !canAddCustom && (
              <div className="px-3 py-3 text-xs text-slate-500 text-center">
                {existing.length > 0 && suggestions.every(s => existing.includes(s))
                  ? 'All agents already added'
                  : 'No matching agents'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── AgentConfigCard ──────────────────────────────────────────────────────────
function AgentConfigCard({
  agentId,
  cfg,
  onUpdate,
  onRemove,
  isUnknown = false,
  fallbackModel,
  agentModel,
}) {
  const [modelConfig, setModelConfig] = useState(null)
  const [modelConfigError, setModelConfigError] = useState('')
  const effectiveModel = resolveRunAgentModel({
    overrideModel: cfg?.model,
    fallbackModel,
    agentModel,
  })
  const tempSet = cfg?.temperature != null
  const temperature = modelConfig?.temperature
  const temperatureControl = getTemperatureControlState(
    temperature,
    cfg?.temperature,
  )
  const forcedTemperature = temperature?.forced
  const minTemperature = forcedTemperature ?? temperature?.min ?? 0
  const maxTemperature = forcedTemperature ?? temperature?.max ?? 2
  const reasoning = modelConfig?.reasoning
  const controlMode = getReasoningControlMode(reasoning)
  const reasoningEfforts = getReasoningEffortOptions(reasoning)
  const selectedEffort = cfg?.reasoning_effort || ''
  const selectedEffortIsUnsupported = Boolean(
    selectedEffort && !reasoningEfforts.includes(selectedEffort),
  )
  const showReasoning = controlMode !== 'hidden' || Boolean(selectedEffort)
  const useEffortSelect = controlMode === 'effort-select' || controlMode === 'hidden'

  useEffect(() => {
    const controller = new AbortController()
    setModelConfig(null)
    setModelConfigError('')
    if (!effectiveModel) return () => controller.abort()

    apiFetch('/settings/model-config/' + modelConfigPath(effectiveModel), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(formatApiDetail(payload.detail))
        }
        return response.json()
      })
      .then((nextConfig) => {
        if (!controller.signal.aborted) setModelConfig(nextConfig)
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setModelConfigError(error.message)
      })

    return () => controller.abort()
  }, [effectiveModel])

  return (
    <div className={`border rounded-lg p-4 bg-slate-900/50 ${isUnknown ? 'border-amber-500/50' : 'border-slate-700'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium text-blue-300">{agentId}</span>
          {isUnknown && (
            <span title="Unknown agent ID — this override will be ignored at runtime" className="flex items-center gap-1 text-xs text-amber-400">
              <AlertTriangle className="w-3 h-3" /> Unknown ID
            </span>
          )}
        </div>
        <button type="button" onClick={onRemove} className="text-slate-500 hover:text-red-400 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <span className="text-xs text-slate-400 block mb-1">Model</span>
          <ModelPicker value={cfg?.model || ''} onChange={v => onUpdate('model', v)} />
          {!cfg?.model && effectiveModel && (
            <span className="text-[11px] text-slate-500">Inherited: {effectiveModel}</span>
          )}
        </div>

        {showReasoning && <div>
          <span className="text-xs text-slate-400 block mb-1">Reasoning Effort</span>
          {useEffortSelect ? (
            <>
              <select
                value={selectedEffort}
                onChange={e => onUpdate('reasoning_effort', e.target.value || null)}
                disabled={!modelConfig}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              >
                <option value="">
                  {reasoning?.default_effort
                    ? `(model default: ${reasoning.default_effort})`
                    : '(agent/model default)'}
                </option>
                {selectedEffortIsUnsupported && (
                  <option value={selectedEffort} disabled>
                    {selectedEffort} (not supported)
                  </option>
                )}
                {reasoningEfforts.map(effort => (
                  <option key={effort} value={effort}>{effort}</option>
                ))}
              </select>
              {reasoning?.mandatory && (
                <span className="text-[11px] text-slate-500">Reasoning is required</span>
              )}
            </>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={Boolean(selectedEffort)}
                  disabled={!modelConfig}
                  onChange={e => onUpdate(
                    'reasoning_effort',
                    e.target.checked ? (reasoning?.default_effort || 'medium') : null,
                  )}
                  className="accent-blue-500"
                />
                Enable reasoning
              </label>
              <span className="text-[11px] text-slate-500">This model exposes no effort selector — using a best-effort default</span>
            </>
          )}
        </div>}


        <div>
          <span className="text-xs text-slate-400 block mb-1">
            Temperature{tempSet ? `: ${cfg.temperature}` : ''}
          </span>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox" checked={tempSet}
              disabled={temperatureControl.disabled}
              onChange={e => onUpdate(
                'temperature',
                e.target.checked
                  ? (forcedTemperature ?? Math.min(maxTemperature, Math.max(minTemperature, 1)))
                  : null,
              )}
              className="accent-blue-500 shrink-0"
            />
            {tempSet ? (
              <input
                type="range" min={minTemperature} max={maxTemperature} step="0.1"
                value={temperatureControl.displayValue}
                disabled={temperatureControl.disabled}
                onChange={e => onUpdate('temperature', parseFloat(e.target.value))}
                className="w-full accent-blue-500 disabled:opacity-50"
              />
            ) : (
              <span className="text-xs text-slate-500 italic">(agent default)</span>
            )}
          </div>
          {temperature?.supported === false && (
            <span className="text-[11px] text-slate-500">Catalog marks this unsupported — may be dropped by the provider</span>
          )}
          {forcedTemperature != null && (
            <span className="text-[11px] text-slate-500">Fixed at {forcedTemperature}</span>
          )}
          {(temperatureControl.unsupportedValue || temperatureControl.forcedMismatch) && (
            <button
              type="button"
              onClick={() => onUpdate(
                'temperature',
                temperatureControl.forcedMismatch ? forcedTemperature : null,
              )}
              className="block text-[11px] text-blue-400 hover:text-blue-300"
            >
              {temperatureControl.forcedMismatch ? 'Use required value' : 'Use model default'}
            </button>
          )}
        </div>

        <div>
          <span className="text-xs text-slate-400 block mb-1">Step Limit</span>
          <input
            type="number" min="1"
            value={cfg?.step_limit ?? ''}
            onChange={e => onUpdate('step_limit', e.target.value ? parseInt(e.target.value, 10) : null)}
            placeholder="(agent default)"
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
          />
        </div>
      </div>
      {modelConfigError && <p className="mt-2 text-xs text-red-400">{modelConfigError}</p>}
    </div>
  )
}

// ─── AgentConfigsEditor ───────────────────────────────────────────────────────
const AgentConfigsEditor = forwardRef(function AgentConfigsEditor({
  value,
  onChange,
  agentSuggestions,
  agentDefaults,
  fallbackModel,
}, ref) {
  const [mode, setMode] = useState('visual')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState(null)

  useImperativeHandle(ref, () => ({
    flush: () => {
      if (mode !== 'json') return { ok: true, value: null }
      try {
        const parsed = JSON.parse(jsonText)
        if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be a JSON object')
        onChange(parsed)
        setJsonError(null)
        return { ok: true, value: parsed }
      } catch (e) {
        setJsonError(e.message)
        return { ok: false, value: null }
      }
    }
  }), [mode, jsonText, onChange])

  const switchToJson = () => {
    setJsonText(JSON.stringify(value, null, 2))
    setJsonError(null)
    setMode('json')
  }

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText)
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be a JSON object')
      onChange(parsed)
      setJsonError(null)
      setMode('visual')
    } catch (e) {
      setJsonError(e.message)
    }
  }

  const addAgent = (agentId) => {
    if (!agentId || Object.prototype.hasOwnProperty.call(value, agentId)) return
    onChange({ ...value, [agentId]: { model: '', reasoning_effort: null, temperature: null, step_limit: null } })
  }

  const removeAgent = (agentId) => {
    const next = { ...value }
    delete next[agentId]
    onChange(next)
  }

  const updateAgent = (agentId, field, val) => {
    onChange({ ...value, [agentId]: { ...(value[agentId] || {}), [field]: val } })
  }

  const existing = Object.keys(value)

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex rounded overflow-hidden border border-slate-600">
          <button
            type="button"
            onClick={() => mode === 'json' ? applyJson() : undefined}
            className={`px-3 py-1 text-xs ${mode === 'visual' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
          >
            Visual
          </button>
          <button
            type="button"
            onClick={() => mode === 'visual' ? switchToJson() : undefined}
            className={`px-3 py-1 text-xs ${mode === 'json' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
          >
            JSON
          </button>
        </div>

        {mode === 'visual' && (
          <AddAgentButton
            suggestions={agentSuggestions}
            existing={existing}
            onAdd={addAgent}
          />
        )}

        {mode === 'json' && (
          <span className="text-xs text-slate-500">Edit JSON, then switch to Visual to apply</span>
        )}
      </div>

      {/* Visual mode */}
      {mode === 'visual' && (
        <div className="space-y-3">
          {existing.length === 0 && (
            <div className="text-sm text-slate-500 py-4 text-center border border-dashed border-slate-700 rounded-lg">
              No agent overrides. Click <strong>Add Agent</strong> to configure one.
            </div>
          )}
          {existing.map(agentId => (
            <AgentConfigCard
              key={agentId}
              agentId={agentId}
              cfg={value[agentId]}
              onUpdate={(field, val) => updateAgent(agentId, field, val)}
              onRemove={() => removeAgent(agentId)}
              isUnknown={agentSuggestions.length > 0 && !agentSuggestions.includes(agentId)}
              fallbackModel={fallbackModel}
              agentModel={agentDefaults[agentId]?.model}
            />
          ))}
        </div>
      )}

      {/* JSON mode */}
      {mode === 'json' && (
        <div>
          <textarea
            value={jsonText}
            onChange={e => { setJsonText(e.target.value); setJsonError(null) }}
            rows={Math.max(8, existing.length * 7)}
            className="w-full font-mono text-xs bg-slate-900 border border-slate-600 rounded-lg p-3 text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            spellCheck={false}
          />
          {jsonError && (
            <div className="mt-1 text-xs text-red-400">JSON error: {jsonError}</div>
          )}
        </div>
      )}
    </div>
  )
})
// ─── Main page ────────────────────────────────────────────────────────────────
export default function RunConfigurations() {
  const [items, setItems] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const agentConfigsEditorRef = useRef(null)
  const [agentSuggestions, setAgentSuggestions] = useState([])
  const [agentDefaults, setAgentDefaults] = useState({})
  const { user: currentUser } = useAuth()
  const isRoot = currentUser?.role === 'root'
  const selected = useMemo(
    () => items.find(x => x._id === selectedId) || null,
    [items, selectedId]
  )
  const isSystemConfig = selected?.tenant_id === '__system__'
  const readOnly = isSystemConfig && !isRoot


  // Load agent ids for autocomplete
  useEffect(() => {
    apiFetch('/configurations/agents/')
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        const agents = data || []
        setAgentSuggestions(agents.map(a => a.id || a._id).filter(Boolean).sort())
        setAgentDefaults(Object.fromEntries(
          agents
            .map(agent => [agent.id || agent._id, agent])
            .filter(([id]) => Boolean(id)),
        ))
      })
      .catch(() => {})
  }, [])

  const loadConfigs = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/configurations/run-configurations/')
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      const data = await res.json()
      const normalized = (data || []).map(normalizeRunConfig)
      setItems(normalized)
      if (normalized.length > 0) {
        setSelectedId(prev =>
          prev && normalized.some(x => x._id === prev) ? prev : normalized[0]._id
        )
      } else {
        setSelectedId(null)
      }
    } catch (err) {
      notify({ title: 'Load failed', message: String(err?.message || err), variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadConfigs() }, [])

  const updateSelected = (patch) => {
    setItems(prev => prev.map(item => item._id !== selectedId ? item : { ...item, ...patch }))
  }

  const addNew = () => {
    const baseId = `run_config_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const draft = { ...emptyRunConfig(), _id: baseId }
    setItems(prev => [draft, ...prev])
    setSelectedId(baseId)
  }

  const saveSelected = async () => {
    if (!selected) return
    const configId = selected._id?.trim()
    const configName = selected.name?.trim()

    if (!configId) {
      notify({ title: 'Validation error', message: 'ID is required', variant: 'error' })
      return
    }
    if (!configName) {
      notify({ title: 'Validation error', message: 'Name is required', variant: 'error' })
      return
    }
    const flushResult = agentConfigsEditorRef.current?.flush()
    if (flushResult?.ok === false) {
      notify({ title: 'Validation error', message: 'Agent configs JSON is invalid — fix errors before saving', variant: 'error' })
      return
    }
    const agentConfigs = flushResult?.value ?? selected.agent_configs
    const cleanAgentConfigs = buildCleanAgentConfigs(agentConfigs)
    
    if (agentSuggestions.length > 0) {
      const unknownAgents = Object.keys(cleanAgentConfigs).filter(id => !agentSuggestions.includes(id))
      if (unknownAgents.length > 0) {
        notify({ title: 'Validation error', message: `Unknown agent ID${unknownAgents.length > 1 ? 's' : ''}: ${unknownAgents.join(', ')}`, variant: 'error' })
        return
      }
    }

    const descriptions = entityDescriptionsForSave(selected)
    const createPayload = {
      _id: configId,
      name: configName,
      ...descriptions,
      is_default: !!selected.is_default,
      approval_mode: selected.approval_mode || null,
      models: selected.models || {},
      agent_configs: cleanAgentConfigs,
    }

    const updatePayload = {
      name: configName,
      ...descriptions,
      is_default: !!selected.is_default,
      approval_mode: selected.approval_mode || null,
      models: selected.models || {},
      agent_configs: cleanAgentConfigs,
    }

    setSaving(true)
    try {
      const isNew = !!selected._isNew
      const res = await apiFetch(
        isNew
          ? '/configurations/run-configurations/'
          : `/configurations/run-configurations/${encodeURIComponent(configId)}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isNew ? createPayload : updatePayload),
        }
      )
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Save failed (${res.status}): ${text}`)
      }
      notify({ title: 'Saved', message: `"${configName}" saved`, variant: 'success' })
      await loadConfigs()
      setSelectedId(configId)
    } catch (err) {
      notify({ title: 'Save failed', message: String(err?.message || err), variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const deleteSelected = async () => {
    if (!selected) return
    if (selected._isNew) {
      const nextItems = items.filter(x => x._id !== selected._id)
      setItems(nextItems)
      setSelectedId(nextItems[0]?._id || null)
      return
    }
    if (!window.confirm(`Delete run configuration "${selected.name}"?`)) return
    try {
      const res = await apiFetch(
        `/configurations/run-configurations/${encodeURIComponent(selected._id)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      notify({ title: 'Deleted', message: `"${selected.name}" deleted`, variant: 'success' })
      await loadConfigs()
    } catch (err) {
      notify({ title: 'Delete failed', message: String(err?.message || err), variant: 'error' })
    }
  }

  const cloneSelected = () => {
    if (!selected) return
    const newId = `run_config_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const clone = {
      _id: newId,
      name: `Copy of ${selected.name || 'run configuration'}`,
      // selected is already form-normalized; copy the full triple so Save does not wipe.
      ...entityDescriptionsForForm(selected),
      is_default: false,
      models: structuredClone(selected.models),
      agent_configs: structuredClone(selected.agent_configs),
      _isNew: true,
    }
    setItems(prev => [clone, ...prev])
    setSelectedId(newId)
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="px-8 py-6 border-b border-slate-800">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-100">Run Configurations</h1>
            <p className="text-slate-400 mt-1">Manage model templates for project runtime subsystems.</p>
          </div>
          <TopNavLinks />
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-8">
        <div className="mb-6 flex items-center gap-3">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>

          <button
            onClick={addNew}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Plus className="w-4 h-4" /> New
          </button>

          <button
            onClick={saveSelected}
            disabled={!selected || saving || readOnly}
            title={readOnly ? 'System config — read-only. Use + New to create a copy.' : undefined}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:cursor-not-allowed text-white"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={deleteSelected}
            disabled={!selected || readOnly}
            title={readOnly ? 'System config — read-only.' : undefined}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:bg-slate-700 disabled:cursor-not-allowed text-white"
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>

          <button
            onClick={cloneSelected}
            disabled={!selected}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:cursor-not-allowed text-slate-100"
          >
            <Copy className="w-4 h-4" /> Clone
          </button>

          <button
            onClick={loadConfigs}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 text-slate-100"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
          {/* Left: list */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <h2 className="text-lg font-semibold text-slate-100 mb-4">Configurations</h2>
            <div className="space-y-2">
              {items.length === 0 && (
                <div className="text-sm text-slate-400">No run configurations found.</div>
              )}
              {items.map(item => (
                <button
                  key={item._id}
                  onClick={() => setSelectedId(item._id)}
                  className={`w-full text-left p-3 rounded-lg border transition ${
                    selectedId === item._id
                      ? 'bg-blue-900/30 border-blue-700 text-slate-100'
                      : 'bg-slate-900/40 border-slate-700 text-slate-300 hover:bg-slate-700/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate">{item.name || item._id}</div>
                    {item.is_default && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
                        default
                      </span>
                    )}
                    {item.tenant_id === '__system__' && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-400">
                        system
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 truncate mt-1">{entityShortDescription(item) || item._id}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Right: detail */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            {!selected ? (
              <div className="text-slate-400">Select a configuration or create a new one.</div>
            ) : (
              <div className="space-y-6">
                {readOnly && (
                  <div className="text-xs text-amber-400 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2">
                    System config — read-only for your tenant. Use <strong>+ New</strong> to create an editable copy.
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="ID">
                    <input
                      value={selected._id}
                      disabled={!selected._isNew}
                      onChange={(e) => {
                        const nextId = e.target.value
                        const prevId = selected._id
                        setItems(prev => prev.map(item =>
                          item._id !== prevId ? item : { ...item, _id: nextId }
                        ))
                        setSelectedId(nextId)
                      }}
                      className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-100 disabled:opacity-60"
                    />
                  </Field>

                  <Field label="Name">
                    <input
                      value={selected.name}
                      onChange={e => updateSelected({ name: e.target.value })}
                      className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
                    />
                  </Field>
                </div>

                <Field label="Short description">
                  <input
                    maxLength={SHORT_DESCRIPTION_MAX_LEN}
                    value={selected.short_description ?? ''}
                    onChange={(e) => updateSelected({ short_description: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
                  />
                </Field>

                <Field label="Long description">
                  <textarea
                    value={selected.long_description ?? ''}
                    onChange={(e) => updateSelected({ long_description: e.target.value })}
                    placeholder="Optional details"
                    rows={4}
                    className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
                  />
                </Field>

                <label className="inline-flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!selected.is_default}
                    onChange={e => updateSelected({ is_default: e.target.checked })}
                    className="rounded"
                  />
                  Is default
                </label>

                <Field label="Approval mode">
                  <select
                    value={selected.approval_mode || ''}
                    onChange={(e) => updateSelected({ approval_mode: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
                  >
                    <option value="">Inherit — decided at launch (human unless overridden)</option>
                    <option value="auto">Auto-approve — skip all gates</option>
                    <option value="human">Require approval at each gate</option>
                  </select>
                  <p className="text-xs text-slate-500 mt-2">
                    Applies when a launch picks “Use run configuration’s setting”. An explicit choice on the start screen overrides this.
                  </p>
                </Field>

                <Field label="Fallback Model">
                  <p className="text-xs text-slate-500 mb-2">
                    Applied to all agents that have no per-agent override in this run config.
                  </p>
                  <ModelPicker
                    value={selected.models?.agent_default || selected.models?.default || ''}
                    onChange={val => updateSelected({ models: { ...selected.models, default: val, agent_default: val } })}
                  />
                </Field>

                <div>
                  <h3 className="text-lg font-semibold text-slate-100 mb-1">Agent Configs</h3>
                  <p className="text-xs text-slate-500 mb-3">
                    Per-agent model and parameter overrides. Keys are agent IDs; values override model,
                    reasoning effort, temperature, and step limit for that agent in this run configuration.
                  </p>
                  <AgentConfigsEditor
                    ref={agentConfigsEditorRef}
                    key={selected._id}
                    value={selected.agent_configs || {}}
                    onChange={agent_configs => updateSelected({ agent_configs })}
                    agentSuggestions={agentSuggestions}
                    agentDefaults={agentDefaults}
                    fallbackModel={selected.models?.agent_default || selected.models?.default || ''}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  )
}
