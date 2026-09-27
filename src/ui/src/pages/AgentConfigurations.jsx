import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Save, Trash2, RefreshCw, ChevronDown, ChevronRight, RotateCcw, ExternalLink, Copy } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import ChipInput from '../components/ChipInput'
import InlineImportJson from '../components/InlineImportJson'
import { apiFetch, formatApiDetail } from '../utils_api'
import useAuth from '../hooks/useAuth'
import usePreselectEntity from '../hooks/usePreselectEntity'
import { SYSTEM_TENANT_ID, buildDelegationTargetSuggestions } from './agentDelegationTargets'
import AgentModelParameters from '../components/AgentModelParameters'
import {
  getAgentResourcePath,
  getAgentStateKey,
  reconcileSavedAgentByKey,
  removeAgentByKey,
  shouldApplyAgentFetch,
  updateAgentFieldByKey,
  updateAgentFieldsByKey,
  updateAgentNameByKey,
} from './agentConfigurationState'
import {
  entityDescriptionsForForm,
  entityDescriptionsForSave,
  entityShortDescription,
  SHORT_DESCRIPTION_MAX_LEN,
} from '../utils/entity_descriptions'

const AGENT_CLASSES = ['GenericAgent']
const AGENT_TYPES = [
  'generic', 'requirements_gatherer', 'requirements_validator', 'planner',
  'coding', 'qa', 'integration', 'critic', 'requirements_finalizer', 'orchestrator',
]

/** MCP public ids use ``server.tool`` (see mcp_tool_ids.parse_mcp_public_tool_id). */
const isMcpPublicToolId = (tid) => {
  const s = String(tid || '').trim()
  const dot = s.indexOf('.')
  return dot > 0 && dot < s.length - 1
}

const mcpToolInCatalog = (tid, catalog) => catalog.has(String(tid || '').trim())

const workflowUsageLabel = (usage) => {
  if (typeof usage === 'string') return usage
  if (!usage || typeof usage !== 'object') return ''
  return String(usage.name || usage.id || '').trim()
}

let _nextKey = 1
const emptyAgent = () => ({
  id: '',
  type: 'generic',
  name: '',
  description: '',
  short_description: '',
  long_description: '',
  agent_class: 'GenericAgent',
  model: 'gpt-5-mini',
  temperature: null,
  system_prompt: '',
  allowed_phases: [],
  allowed_tools: [],
  allowed_mcp_tools: [],
  allowed_delegation_targets: [],
  output_save_key: '',
  use_streaming: null,
  reasoning_effort: '',
  step_limit: null,
  enabled: true,
  _isNew: true,
  _autoId: true,
  _expanded: true,
  _key: `new_${_nextKey++}`,
  _editRevision: 0,
})

// ─────────────────────────────────────────────────────────────────────────────
// AgentConfigurations
// ─────────────────────────────────────────────────────────────────────────────
export default function AgentConfigurations() {
  const { user: currentUser } = useAuth()
  const isRoot = currentUser?.role === 'root'
  const [agents, setAgents] = useState([])
  const [tools, setTools] = useState([])
  const [mcpTools, setMcpTools] = useState([])
  const [a2aServers, setA2aServers] = useState([])
  const [phases, setPhases] = useState([])
  const [loading, setLoading] = useState(true)
  const [mcpCatalogSet, setMcpCatalogSet] = useState(new Set())
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState({})
  const [expandedIds, setExpandedIds] = useState(new Set())
  const agentFetchGenerationRef = useRef(0)
  const agentStateGenerationRef = useRef(0)
  const activeAgentWritesRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const requestGeneration = ++agentFetchGenerationRef.current
    const stateGenerationAtStart = agentStateGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      // Модели больше не грузим здесь — каждый ModelPicker делает это сам
      const [agentsRes, toolsRes, mcpToolsRes, wfRes, a2aRes] = await Promise.all([
        apiFetch('/configurations/agents/'),
        apiFetch('/configurations/tools/'),
        apiFetch('/configurations/mcp-tools/'),
        apiFetch('/configurations/workflows/'),
        apiFetch('/configurations/a2a/?include_disabled=false'),
      ])
      const agentsData = await agentsRes.json()
      const builtinTools = toolsRes.ok ? await toolsRes.json() : []
      const mcpToolDocs = mcpToolsRes.ok ? await mcpToolsRes.json() : []
      const a2aData = a2aRes.ok ? await a2aRes.json() : []
      // Builtin allow-lists store and the runtime matches the wire `name`
      // (tools.yaml slug) — `_id` is opaque storage identity since the
      // UUIDv7 migration. MCP docs below are different: their serializer
      // rewrites `_id` to the public wire id, so id-mapping stays right.
      const builtinIds = [...new Set(
        builtinTools.map(t => t.name || t.id || t._id).filter(Boolean)
      )].sort()
      const mcpIds = mcpToolDocs.map(t => t.id || t._id).filter(Boolean)
      const mcpIdSet = new Set(mcpIds)
      const wfData = await wfRes.json()
      const nextAgents = agentsData.map((a) => {
        const rawTools = a.allowed_tools || []
        const rawMcp = a.allowed_mcp_tools || []
        const legacyMcp = rawMcp.length === 0
          && rawTools.some((tid) => mcpToolInCatalog(tid, mcpIdSet) || isMcpPublicToolId(tid))
        let allowed_tools = legacyMcp
          ? rawTools.filter((tid) => !mcpToolInCatalog(tid, mcpIdSet) && !isMcpPublicToolId(tid))
          : [...rawTools]
        let allowed_mcp_tools = legacyMcp
          ? rawTools.filter((tid) => mcpToolInCatalog(tid, mcpIdSet) || isMcpPublicToolId(tid))
          : [...rawMcp]
        if (!legacyMcp) {
          const strayMcp = allowed_tools.filter((tid) => isMcpPublicToolId(tid))
          if (strayMcp.length) {
            allowed_tools = allowed_tools.filter((tid) => !isMcpPublicToolId(tid))
            allowed_mcp_tools = [...new Set([...allowed_mcp_tools, ...strayMcp])]
          }
        }
        return {
          ...a,
          ...entityDescriptionsForForm(a),
          allowed_tools,
          allowed_mcp_tools,
          _isNew: false,
          _dirty: false,
          _editRevision: 0,
        }
      })

      if (requestGeneration !== agentFetchGenerationRef.current) return
      setAgents(currentAgents => shouldApplyAgentFetch({
        requestGeneration,
        latestRequestGeneration: agentFetchGenerationRef.current,
        stateGenerationAtStart,
        currentStateGeneration: agentStateGenerationRef.current,
        activeWrites: activeAgentWritesRef.current,
      }) ? nextAgents : currentAgents)
      setMcpCatalogSet(mcpIdSet)
      setTools(builtinIds)
      setMcpTools(mcpIds)
      setA2aServers(Array.isArray(a2aData) ? a2aData : [])
      // Workflows are fetched here only for phase suggestions; usage comes from agents API.
      const phaseSet = new Set()
      for (const wf of wfData) {
        for (const node of (wf.nodes || [])) {
          if (node.type === 'phase' && node.task_type) phaseSet.add(node.task_type)
          if (node.phase_label) phaseSet.add(node.phase_label)
        }
      }
      setPhases([...phaseSet].sort())
    } catch (err) {
      if (requestGeneration === agentFetchGenerationRef.current) {
        setError(err.message)
      }
    } finally {
      if (requestGeneration === agentFetchGenerationRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll, currentUser?.tenant_id, currentUser?.role])

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Deep link from the Events-tab cog (?agent=<name>): expand and scroll to it.
  const [wantedAgent, highlightedAgent] = usePreselectEntity('agent', !loading && agents.length > 0)
  const preselectedRef = useRef('')
  useEffect(() => {
    // Expand once per deep-link target; agents change identity on every edit, and
    // re-expanding after the user collapsed it would fight them.
    if (loading || !wantedAgent || preselectedRef.current === wantedAgent) return
    const hit = agents.find(a => a.name === wantedAgent || a.id === wantedAgent || a.display_name === wantedAgent)
    if (hit && !hit._isNew) {
      preselectedRef.current = wantedAgent
      setExpandedIds(prev => (prev.has(hit.id) ? prev : new Set(prev).add(hit.id)))
    }
  }, [loading, wantedAgent, agents])

  const updateField = useCallback((agentKey, field, value) => {
    agentStateGenerationRef.current += 1
    setAgents(prev => updateAgentFieldByKey(prev, agentKey, field, value))
  }, [])

  const updateFields = useCallback((agentKey, fields) => {
    agentStateGenerationRef.current += 1
    setAgents(prev => updateAgentFieldsByKey(prev, agentKey, fields))
  }, [])

  const updateName = useCallback((agentKey, name) => {
    agentStateGenerationRef.current += 1
    setAgents(prev => updateAgentNameByKey(prev, agentKey, name, AGENT_TYPES))
  }, [])

  const addAgent = () => {
    const a = emptyAgent()
    agentStateGenerationRef.current += 1
    setAgents(prev => [a, ...prev])
    setExpandedIds(prev => new Set(prev).add(''))
  }

  const saveAgent = async (agentKey) => {
    const agent = agents.find((candidate) => getAgentStateKey(candidate) === agentKey)
    if (!agent) return

    activeAgentWritesRef.current += 1
    agentStateGenerationRef.current += 1
    setSaving(prev => ({ ...prev, [agentKey]: true }))
    try {
      const body = {
        ...agent,
        ...entityDescriptionsForSave(agent),
        allowed_tools: [...(agent.allowed_tools || [])],
        allowed_mcp_tools: [...(agent.allowed_mcp_tools || [])],
      }
      delete body._isNew
      delete body._dirty
      delete body._expanded
      delete body._key
      delete body._editRevision
      delete body._autoId
      delete body.workflow_usage
      delete body.workflow_usage_count

      // Clean up empty optional fields
      if (!body.output_save_key) delete body.output_save_key
      if (body.step_limit === null || body.step_limit === '') delete body.step_limit
      if (body.use_streaming === null) delete body.use_streaming

      let res
      if (agent._isNew) {
        res = await apiFetch('/configurations/agents/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        // PUT — send only changed fields (exclude id, type which are immutable)
        const { id: _id, type: _type, ...updateBody } = body
        res = await apiFetch(getAgentResourcePath(agent, { isRoot }), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody),
        })
      }

      if (!res.ok) {
        const err = await res.json()
        throw new Error(formatApiDetail(err.detail || err))
      }

      const saved = await res.json()
      const normalizedSaved = {
        ...saved,
        ...entityDescriptionsForForm(saved),
      }
      setAgents(prev => reconcileSavedAgentByKey(
        prev,
        agentKey,
        agent,
        normalizedSaved,
      ))

      // Auto hot-reload so in-memory agent pool stays in sync with DB
      if (!agent._isNew) {
        try {
          await apiFetch(
            getAgentResourcePath(saved, { isRoot, reload: true }),
            { method: 'POST' },
          )
        } catch (_) { /* reload is best-effort */ }
      }
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    } finally {
      activeAgentWritesRef.current -= 1
      agentStateGenerationRef.current += 1
      setSaving(prev => ({ ...prev, [agentKey]: false }))
    }
  }

  const deleteAgent = async (agentKey) => {
    const agent = agents.find((candidate) => getAgentStateKey(candidate) === agentKey)
    if (!agent) return

    if (agent._isNew) {
      agentStateGenerationRef.current += 1
      setAgents(prev => removeAgentByKey(prev, agentKey))
      return
    }
    const usedIn = (agent.workflow_usage || []).map(workflowUsageLabel).filter(Boolean)
    const usageCount = typeof agent.workflow_usage_count === 'number'
      ? agent.workflow_usage_count
      : usedIn.length
    const usageWarning = usageCount > 0
      ? `\n\n⚠️ This agent is used in ${usageCount} workflow(s): ${usedIn.join(', ')}`
      : ''
    if (!confirm(`Delete agent "${agent.name || agent.id}"?${usageWarning}`)) return
    const deleteStatusKey = `delete:${agentKey}`
    activeAgentWritesRef.current += 1
    agentStateGenerationRef.current += 1
    setSaving(prev => ({ ...prev, [deleteStatusKey]: true }))
    try {
      const res = await apiFetch(
        getAgentResourcePath(agent, { isRoot }),
        { method: 'DELETE' },
      )
      if (!res.ok && res.status !== 204) {
        const err = await res.json()
        throw new Error(err.detail || 'Delete failed')
      }
      setAgents(prev => removeAgentByKey(prev, agentKey))
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    } finally {
      activeAgentWritesRef.current -= 1
      agentStateGenerationRef.current += 1
      setSaving(prev => ({ ...prev, [deleteStatusKey]: false }))
    }
  }

  const reloadAgent = async (agentKey) => {
    const agent = agents.find((candidate) => getAgentStateKey(candidate) === agentKey)
    if (!agent) return
    if (agent._isNew) return
    const reloadStatusKey = `reload:${agentKey}`
    setSaving(prev => ({ ...prev, [reloadStatusKey]: true }))
    try {
      const res = await apiFetch(
        getAgentResourcePath(agent, { isRoot, reload: true }),
        { method: 'POST' },
      )
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Reload failed')
      }
      const data = await res.json()
      alert(`Agent "${agent.id}" reloaded (replaced=${data.replaced})`)
    } catch (err) {
      alert(`Reload failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [reloadStatusKey]: false }))
    }
  }

  const cloneAgent = (agentKey) => {
    agentStateGenerationRef.current += 1
    setAgents(prev => {
      const agent = prev.find(candidate => getAgentStateKey(candidate) === agentKey)
      if (!agent) return prev

      const suffix = Date.now().toString(36).slice(-4)
      const baseId = (agent.id || 'agent').slice(0, 54)
      const displayName = `Copy of ${agent.display_name || agent.name}`
      const clone = {
        ...agent,
        id: `${baseId}_copy_${suffix}`,
        name: displayName,
        display_name: displayName,
        _isNew: true,
        _autoId: false,
        _dirty: true,
        _key: `new_${_nextKey++}`,
        _editRevision: 0,
      }
      delete clone.dangling_references
      return [clone, ...prev]
    })
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* Header */}
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">Agent Configurations</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">Agents</h1>
          <div className="flex gap-2">
            <button onClick={fetchAll} className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <InlineImportJson kind="agents" onImported={fetchAll} />
            <button onClick={addAgent} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> New Agent
            </button>
          </div>
        </div>

        {error && <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">{error}</div>}
        {loading && <div className="text-slate-400 text-sm">Loading...</div>}

        {/* Agent cards */}
        <div className="space-y-3">
          {agents.map((agent) => {
            const agentStateKey = getAgentStateKey(agent)
            const savePending = Boolean(saving[agentStateKey])
            const deletePending = Boolean(saving[`delete:${agentStateKey}`])
            const reloadPending = Boolean(saving[`reload:${agentStateKey}`])
            const operationPending = savePending || deletePending || reloadPending
            const isExpanded = agent._isNew || expandedIds.has(agent.id)
            const fallbackTenantId = agent._isNew
              ? (currentUser?.role === 'root' ? SYSTEM_TENANT_ID : currentUser?.tenant_id)
              : null
            const delegationTargetSuggestions = buildDelegationTargetSuggestions(agent, agents, {
              fallbackTenantId,
              a2aServers,
            })
            const workflowUsageNames = (agent.workflow_usage || []).map(workflowUsageLabel).filter(Boolean)
            const workflowUsageCount = typeof agent.workflow_usage_count === 'number'
              ? agent.workflow_usage_count
              : workflowUsageNames.length
            return (
              <div
                key={agentStateKey}
                data-preselect={agent.name || undefined}
                className={`bg-slate-800 border rounded-lg overflow-hidden ${highlightedAgent && agent.name === highlightedAgent ? 'border-blue-500 ring-2 ring-blue-500/60' : 'border-slate-700'}`}
              >
                {/* Card header */}
                <button
                  onClick={() => !agent._isNew && toggleExpand(agent.id)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-750"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                    <span className="font-medium">{agent.display_name || agent.name || agent.id || '(new agent)'}</span>
                    {entityShortDescription(agent) && (
                      <span className="text-xs text-slate-500 truncate max-w-xs">{entityShortDescription(agent)}</span>
                    )}
                    <span className="text-xs text-slate-500">{agent.type}</span>
                    {agent._dirty && <span className="text-xs text-yellow-400">unsaved</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {workflowUsageCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400" title={`Used in: ${workflowUsageNames.join(', ')}`}>
                        {workflowUsageCount} workflow{workflowUsageCount > 1 ? 's' : ''}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded ${agent.enabled ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
                      {agent.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <span className="text-xs text-slate-500">{agent.agent_class}</span>
                  </div>
                </button>

                {/* Expanded form */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-slate-700 pt-3">
                    {/* Name (first field, full width for new agents) */}
                    {agent._isNew && (
                      <div className="mb-3">
                        <Field label="Name">
                          <input
                            type="text" value={agent.display_name || agent.name}
                            onChange={e => updateName(agentStateKey, e.target.value)}
                            placeholder="e.g. Chat Agent"
                            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                            autoFocus
                          />
                        </Field>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="ID" disabled={!agent._isNew}>
                        <input
                          type="text" value={agent.id} disabled={!agent._isNew}
                          onChange={e => updateField(agentStateKey, 'id', e.target.value)}
                          placeholder="auto-filled from name"
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm disabled:opacity-50"
                        />
                      </Field>

                      {/* Type (role category for auction matching) — always editable */}
                      <Field label="Type (role)">
                        <select
                          value={agent.type}
                          onChange={e => updateField(agentStateKey, 'type', e.target.value)}
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        >
                          <option value="">-- select role --</option>
                          {AGENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <span className="text-[10px] text-slate-500 mt-1 block">Auction eligibility — agents bid on tasks matching their role</span>
                      </Field>

                      {/* Name (inline for existing agents) */}
                      {!agent._isNew && (
                        <Field label="Name">
                          <input
                            type="text" value={agent.display_name || agent.name}
                            onChange={e => updateField(agentStateKey, 'display_name', e.target.value)}
                            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                          />
                        </Field>
                      )}

                      {/* Agent Class */}
                      <Field label="Agent Class">
                        <select
                          value={agent.agent_class}
                          onChange={e => updateField(agentStateKey, 'agent_class', e.target.value)}
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        >
                          {AGENT_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </Field>

                      {/* Model — заменяем <select> на ModelPicker с поиском */}
                      <AgentModelParameters
                        agent={agent}
                        agentKey={agentStateKey}
                        onChange={updateField}
                        onChangeMany={updateFields}
                      />

                      {/* Step Limit */}
                      <Field label="Step Limit">
                        <input
                          type="number" min="1" max="100"
                          value={agent.step_limit ?? ''}
                          onChange={e => updateField(agentStateKey, 'step_limit', e.target.value ? parseInt(e.target.value) : null)}
                          placeholder="(unlimited)"
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        />
                      </Field>

                      {/* Enabled */}
                      <Field label="Enabled">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox" checked={agent.enabled}
                            onChange={e => updateField(agentStateKey, 'enabled', e.target.checked)}
                            className="accent-blue-500"
                          />
                          <span className="text-sm">{agent.enabled ? 'Yes' : 'No'}</span>
                        </label>
                      </Field>

                      {/* Output Save Key */}
                      <Field label="Output Save Key">
                        <input
                          type="text" value={agent.output_save_key || ''}
                          onChange={e => updateField(agentStateKey, 'output_save_key', e.target.value || null)}
                          placeholder="(optional)"
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        />
                      </Field>
                    </div>

                    {/* Descriptions */}
                    <div className="mt-3 grid grid-cols-1 gap-3">
                      <Field label="Short description">
                        <input
                          type="text"
                          maxLength={SHORT_DESCRIPTION_MAX_LEN}
                          value={agent.short_description ?? ''}
                          onChange={e => updateField(agentStateKey, 'short_description', e.target.value)}
                          placeholder="Card / list text"
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                        />
                      </Field>
                      <Field label="Long description">
                        <textarea
                          value={agent.long_description ?? ''}
                          onChange={e => updateField(agentStateKey, 'long_description', e.target.value)}
                          placeholder="Detailed description"
                          rows={3}
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm resize-y"
                        />
                      </Field>
                    </div>

                    {/* System Prompt */}
                    <div className="mt-3">
                      <Field label="System Prompt">
                        <textarea
                          value={agent.system_prompt}
                          onChange={e => updateField(agentStateKey, 'system_prompt', e.target.value)}
                          rows={5}
                          className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm font-mono resize-y"
                        />
                      </Field>
                    </div>

                    {/* Allowed Phases */}
                    <div className="mt-3">
                      <Field label="Allowed Phases">
                        <ChipInput
                          values={agent.allowed_phases || []}
                          onChange={v => updateField(agentStateKey, 'allowed_phases', v)}
                          suggestions={phases}
                          placeholder="Type phase name and press Enter..."
                        />
                        <Link
                          to="/workflow-builder"
                          target="_blank"
                          className="inline-flex items-center gap-1 mt-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Manage workflows
                        </Link>
                      </Field>
                    </div>

                    {/* Allowed Tools (built-in) */}
                    <div className="mt-3">
                      <Field label="Allowed Tools">
                        <ChipInput
                          values={agent.allowed_tools || []}
                          onChange={v => updateField(agentStateKey, 'allowed_tools', v)}
                          suggestions={tools}
                          placeholder="Built-in tools (create, read, grep, …)"
                        />
                        <Link
                          to="/configurations/tools"
                          target="_blank"
                          className="inline-flex items-center gap-1 mt-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Manage tools
                        </Link>
                      </Field>
                    </div>

                    {/* Allowed MCP Tools */}
                    <div className="mt-3">
                      <Field label="Allowed MCP Tools">
                        <ChipInput
                          values={agent.allowed_mcp_tools || []}
                          onChange={v => updateField(agentStateKey, 'allowed_mcp_tools', v)}
                          suggestions={mcpTools}
                          placeholder="MCP tool ids (server.tool_name)"
                          chipClassName={(val) => {
                            const dangling = new Set(agent.dangling_references || [])
                            if (dangling.has(val)) {
                              return 'bg-amber-600/30 border-amber-500/60 text-amber-100'
                            }
                            return isMcpPublicToolId(val)
                              ? 'bg-purple-600/40 border-purple-500/50 text-purple-200'
                              : undefined
                          }}
                        />
                        <p className="mt-1 text-[11px] text-slate-500">
                          Amber chips are dangling references from the API; refs are kept and may work after setup.
                        </p>
                        <Link
                          to="/configurations/mcp-tools"
                          target="_blank"
                          className="inline-flex items-center gap-1 mt-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Manage MCP tools
                        </Link>
                      </Field>
                    </div>

                    {/* Allowed Delegation Targets */}
                    <div className="mt-3">
                      <Field label="Allowed Delegation Targets">
                        <ChipInput
                          values={agent.allowed_delegation_targets || []}
                          onChange={v => updateField(agentStateKey, 'allowed_delegation_targets', v)}
                          suggestions={delegationTargetSuggestions}
                          placeholder="Type target agent id, or * for same-tenant/system agents..."
                        />
                        <p className="mt-1 text-[11px] text-slate-500">
                          Used only when allowed_tools includes delegate_to_agent. Empty disables delegation targets. Cross-tenant targets are blocked.
                        </p>
                      </Field>
                    </div>

                    {/* Workflow usage info */}
                    {!agent._isNew && workflowUsageCount > 0 && (
                      <div className="mt-3 p-2.5 bg-slate-700/40 border border-slate-600/50 rounded">
                        <span className="text-xs text-slate-400">Used in workflows: </span>
                        {workflowUsageNames.map((wfName, i) => (
                          <span key={wfName}>
                            {i > 0 && <span className="text-slate-600">, </span>}
                            <span className="text-xs text-blue-300">{wfName}</span>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="mt-4 flex items-center gap-2 border-t border-slate-700 pt-3">
                      <button
                        onClick={() => saveAgent(agentStateKey)}
                        disabled={operationPending}
                        className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {savePending ? 'Saving...' : agent._isNew ? 'Create' : 'Save'}
                      </button>
                      {!agent._isNew && (
                        <button
                          onClick={() => reloadAgent(agentStateKey)}
                          disabled={operationPending}
                          className="px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 rounded flex items-center gap-1 disabled:opacity-50"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          {reloadPending ? 'Reloading...' : 'Hot Reload'}
                        </button>
                      )}
                      <button
                        onClick={() => cloneAgent(agentStateKey)}
                        disabled={operationPending}
                        className="px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 rounded flex items-center gap-1 disabled:opacity-50"
                      >
                        <Copy className="w-3.5 h-3.5" /> Clone
                      </button>
                      <button
                        onClick={() => deleteAgent(agentStateKey)}
                        disabled={operationPending}
                        className="px-3 py-1.5 text-xs bg-red-700 hover:bg-red-600 rounded flex items-center gap-1 ml-auto disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {deletePending ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {!loading && agents.length === 0 && (
          <div className="text-center text-slate-500 py-12">
            No agents configured. Click <strong>+ New Agent</strong> to create one.
          </div>
        )}
      </main>
    </div>
  )
}

function Field({ label, disabled, children }) {
  return (
    <div className={`block ${disabled ? 'opacity-60' : ''}`}>
      <span className="text-xs text-slate-400 mb-1 block">{label}</span>
      {children}
    </div>
  )
}
