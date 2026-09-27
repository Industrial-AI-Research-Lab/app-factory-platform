const SERVER_AUTHORITATIVE_AGENT_FIELDS = new Set(['id', 'tenant_id'])
const ALL_REASONING_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']

export const getReasoningEffortOptions = (reasoning) => {
  if (!reasoning?.supported) return []
  const efforts = Array.isArray(reasoning.supported_efforts)
    ? reasoning.supported_efforts
    : ALL_REASONING_EFFORTS
  return reasoning.mandatory
    ? efforts.filter((effort) => effort !== 'none')
    : [...efforts]
}

export const getReasoningControlMode = (reasoning) => {
  if (!reasoning?.supported) return 'hidden'
  const efforts = reasoning.supported_efforts
  if (!Array.isArray(efforts)) return 'effort-select'
  return efforts.length > 0 ? 'effort-select' : 'toggle'
}

export const getAgentModelChangeFields = (model) => ({
  model,
  temperature: null,
})

export const resolveRunAgentModel = ({ overrideModel, fallbackModel, agentModel }) => (
  [overrideModel, fallbackModel, agentModel]
    .find((value) => typeof value === 'string' && value.trim())
    ?.trim() || ''
)

export const getTemperatureControlState = (temperature, currentValue) => {
  const unsupported = temperature?.supported === false
  const forced = temperature?.forced
  return {
    disabled: !temperature || forced != null,
    displayValue: forced ?? currentValue ?? 1,
    forcedMismatch: forced != null && currentValue != null && !Object.is(forced, currentValue),
    unsupportedValue: unsupported && currentValue != null,
  }
}

const getAgentEditRevision = (agent) => {
  const revision = agent?._editRevision
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

export const getAgentResourcePath = (
  agent,
  { isRoot = false, reload = false } = {},
) => {
  const agentId = encodeURIComponent(String(agent?.id || '').trim())
  const suffix = reload ? '/reload' : ''
  const path = `/configurations/agents/${agentId}${suffix}`
  if (!isRoot) return path

  const tenantId = String(agent?.tenant_id || '__system__').trim() || '__system__'
  return `${path}?tenant_id=${encodeURIComponent(tenantId)}`
}

export const getAgentStateKey = (agent) => {
  if (agent?._key) return agent._key

  const id = String(agent?.id || '').trim()
  if (!id) return ''
  const tenantId = String(agent?.tenant_id || '__system__').trim() || '__system__'
  return `saved:${JSON.stringify([tenantId, id])}`
}

export const updateAgentFieldsByKey = (agents, agentKey, fields) => {
  if (!agentKey) return agents

  let changed = false
  const updated = agents.map((agent) => {
    if (getAgentStateKey(agent) !== agentKey) {
      return agent
    }

    const changedFields = Object.fromEntries(
      Object.entries(fields).filter(([field, value]) => !Object.is(agent[field], value)),
    )
    if (Object.keys(changedFields).length === 0) return agent

    changed = true
    return {
      ...agent,
      ...changedFields,
      _dirty: true,
      _editRevision: getAgentEditRevision(agent) + 1,
    }
  })
  return changed ? updated : agents
}

export const updateAgentFieldByKey = (agents, agentKey, field, value) => {
  const agent = agents.find(candidate => getAgentStateKey(candidate) === agentKey)
  const fields = field === 'id' && agent?._isNew
    ? { id: value, _autoId: false }
    : { [field]: value }
  return updateAgentFieldsByKey(agents, agentKey, fields)
}

export const updateAgentNameByKey = (agents, agentKey, name, agentTypes) => {
  const agent = agents.find(candidate => getAgentStateKey(candidate) === agentKey)
  if (!agent?._isNew) return agents

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return updateAgentFieldsByKey(agents, agentKey, {
    name,
    display_name: name,
    ...(agent._autoId ? { id: slug } : {}),
    type: agent.type || agentTypes.find(type => type === slug) || '',
  })
}

export const shouldApplyAgentFetch = ({
  requestGeneration,
  latestRequestGeneration,
  stateGenerationAtStart,
  currentStateGeneration,
  activeWrites,
}) => (
  requestGeneration === latestRequestGeneration
  && stateGenerationAtStart === currentStateGeneration
  && activeWrites === 0
)

export const reconcileSavedAgentByKey = (
  agents,
  agentKey,
  submittedAgent,
  savedAgent,
) => {
  if (!agentKey) return agents

  const targetIndex = agents.findIndex(
    (agent) => getAgentStateKey(agent) === agentKey,
  )
  if (targetIndex < 0) return agents

  const currentAgent = agents[targetIndex]
  const submittedRevision = getAgentEditRevision(submittedAgent)
  const currentRevision = getAgentEditRevision(currentAgent)
  const hasPostSubmitEdits = currentRevision > submittedRevision
  const reconciled = {
    ...savedAgent,
    _isNew: false,
    _dirty: false,
    _editRevision: hasPostSubmitEdits ? currentRevision : submittedRevision,
  }

  if (hasPostSubmitEdits) {
    for (const [field, value] of Object.entries(currentAgent)) {
      if (
        field.startsWith('_')
        || SERVER_AUTHORITATIVE_AGENT_FIELDS.has(field)
      ) {
        continue
      }
      if (!Object.is(value, submittedAgent?.[field])) {
        reconciled[field] = value
        reconciled._dirty = true
      }
    }
  }

  const updated = [...agents]
  updated[targetIndex] = reconciled
  return updated
}

export const removeAgentByKey = (agents, agentKey) => {
  if (!agentKey) return agents

  const targetIndex = agents.findIndex(
    (agent) => getAgentStateKey(agent) === agentKey,
  )
  if (targetIndex < 0) return agents

  return [
    ...agents.slice(0, targetIndex),
    ...agents.slice(targetIndex + 1),
  ]
}
