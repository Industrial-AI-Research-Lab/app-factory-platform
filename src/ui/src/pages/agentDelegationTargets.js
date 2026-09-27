export const ALL_DELEGATION_TARGETS_TOKEN = '*'
export const SYSTEM_TENANT_ID = '__system__'

export function getAgentConfigId(agent) {
  return String(agent?.id || agent?._id || agent?.agent_id || '').trim()
}

function normalizeTenantId(value) {
  const text = String(value || '').trim()
  return text || null
}

function getAgentTenantId(agent, fallbackTenantId = null) {
  return (
    normalizeTenantId(agent?.tenant_id)
    || normalizeTenantId(agent?.config?.tenant_id)
    || normalizeTenantId(fallbackTenantId)
  )
}

function canSuggestDelegationTarget(sourceAgent, targetAgent, fallbackTenantId = null) {
  const sourceId = getAgentConfigId(sourceAgent)
  const targetId = getAgentConfigId(targetAgent)
  if (!targetId || targetId === sourceId) return false

  const sourceTenant = getAgentTenantId(sourceAgent, fallbackTenantId)
  const targetTenant = getAgentTenantId(targetAgent)
  if (targetTenant === SYSTEM_TENANT_ID) return true
  if (!sourceTenant) return !targetTenant
  return sourceTenant === targetTenant
}

export function buildDelegationTargetSuggestions(sourceAgent, agents, options = {}) {
  const suggestions = [ALL_DELEGATION_TARGETS_TOKEN]
  const seen = new Set(suggestions)
  const fallbackTenantId = options.fallbackTenantId
  const sourceTenant = getAgentTenantId(sourceAgent, fallbackTenantId)

  for (const candidate of agents || []) {
    if (!canSuggestDelegationTarget(sourceAgent, candidate, fallbackTenantId)) continue

    const id = getAgentConfigId(candidate)
    if (seen.has(id)) continue

    suggestions.push(id)
    seen.add(id)
  }

  for (const server of options.a2aServers || []) {
    const name = String(server?.name || '').trim()
    const tenantId = getAgentTenantId(server)
    if (
      !name
      || seen.has(name)
      || server?.enabled !== true
      || !sourceTenant
      || tenantId !== sourceTenant
    ) continue

    suggestions.push({
      value: name,
      label: `A2A · ${name}`,
      kind: 'a2a',
    })
    seen.add(name)
  }

  return suggestions
}
