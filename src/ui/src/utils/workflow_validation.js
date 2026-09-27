import {
  FULL_CONTEXT_READS_TOKEN,
  READ_ONLY_WRITE_KEYS,
  WORKFLOW_DEFAULT_READS_TOKEN,
  normalizeContractKeyList,
} from './workflow_serializer.js'

function hasField(obj, field) {
  return Object.prototype.hasOwnProperty.call(obj || {}, field) && obj[field] != null && obj[field] !== ''
}

function nodeDisplayName(nodeData, nodeId) {
  // Banner errors used to cite only the internal node id, which the canvas
  // stops showing once the user renames the label — name by label, keep the
  // id in parens so the message still points at one specific node.
  const label = String(nodeData?.label || '').trim()
  const id = nodeId || 'unknown'
  return label && label !== id ? `'${label}' (${id})` : `'${id}'`
}

function readsIssues(reads, subject) {
  if (!reads.includes(FULL_CONTEXT_READS_TOKEN) || reads.length < 2) return []
  return [{
    fields: ['reads'],
    message: `${subject} reads cannot combine full context with other keys`,
    short: "Full context ('*') cannot be combined with other keys.",
  }]
}

function writesIssues(writes, subject) {
  const issues = []
  if (writes.includes(FULL_CONTEXT_READS_TOKEN)) {
    issues.push({
      fields: ['writes'],
      message: `${subject} writes cannot use '*'`,
      short: "Writes cannot use '*'.",
    })
  }
  if (writes.includes(WORKFLOW_DEFAULT_READS_TOKEN)) {
    issues.push({
      fields: ['writes'],
      message: `${subject} writes cannot use '${WORKFLOW_DEFAULT_READS_TOKEN}'`,
      short: `Writes cannot use '${WORKFLOW_DEFAULT_READS_TOKEN}'.`,
    })
  }
  for (const key of writes) {
    if (READ_ONLY_WRITE_KEYS.includes(key)) {
      issues.push({
        fields: ['writes'],
        message: `${subject} writes contains read-only key '${key}'`,
        short: `'${key}' is read-only and cannot be written.`,
      })
    }
  }
  return issues
}

// Mirrors orchestration/tool_node_contract.py, which rejects the same nodes on save.
function toolNodeIssues(nodeData, name) {
  const issues = []
  for (const field of ['operation', 'server', 'binding']) {
    if (!String(nodeData?.[field] || '').trim()) {
      issues.push({
        fields: [field],
        message: `Tool node ${name} must define '${field}'`,
        short: 'Required.',
      })
    }
  }
  const writes = normalizeContractKeyList(nodeData?.writes)
  if (writes.length !== 1) {
    issues.push({
      fields: ['writes'],
      message: `Tool node ${name} must write exactly one context key`,
      short: 'Name exactly one context key for the result.',
    })
  }
  issues.push(...readsIssues(normalizeContractKeyList(nodeData?.reads), `Tool node ${name}`))
  issues.push(...writesIssues(writes, `Tool node ${name}`))
  return issues
}

const MAP_BOUNDS = { batch_size: [1, 50], concurrency: [1, 16], max_item_attempts: [1, 5] }
const ITEM_CHECK_KINDS = ['json_schema', 'value_relation']

// Mirrors orchestration/map_node_contract.py, which rejects the same nodes on save.
function mapNodeIssues(nodeData, name) {
  const subject = `Map node ${name}`
  const issues = []
  for (const field of ['agent_type', 'items_from']) {
    if (!String(nodeData?.[field] || '').trim()) {
      issues.push({ fields: [field], message: `${subject} must define '${field}'`, short: 'Required.' })
    }
  }
  for (const [field, [low, high]] of Object.entries(MAP_BOUNDS)) {
    if (!hasField(nodeData, field)) continue
    const value = Number(nodeData[field])
    if (!Number.isInteger(value) || value < low || value > high) {
      issues.push({
        fields: [field],
        message: `${subject} ${field} must be an integer between ${low} and ${high}`,
        short: `A whole number from ${low} to ${high}.`,
      })
    }
  }
  const writes = normalizeContractKeyList(nodeData?.writes)
  if (writes.length !== 1) {
    issues.push({
      fields: ['writes'],
      message: `${subject} must write exactly one context key`,
      short: 'Name exactly one context key for the collected outputs.',
    })
  }
  const checks = Array.isArray(nodeData?.item_checks) ? nodeData.item_checks : []
  checks.forEach((check, index) => {
    if (!ITEM_CHECK_KINDS.includes(check?.kind)) {
      issues.push({
        fields: ['item_checks'],
        message: `${subject} item_checks[${index}] kind must be one of ${ITEM_CHECK_KINDS.join(', ')}`,
      })
    }
    if (String(check?.key || '').split('.')[0] !== 'item') {
      issues.push({
        fields: ['item_checks'],
        message: `${subject} item_checks[${index}] key must be 'item' or start with 'item.'`,
      })
    }
  })
  issues.push(...readsIssues(normalizeContractKeyList(nodeData?.reads), subject))
  issues.push(...writesIssues(writes, subject))
  return issues
}

// Each issue: fields = panel field keys it anchors to, message = banner
// text, short = text rendered under the field itself.
export function getNodeValidationIssues(nodeData = {}, nodeId = '') {
  const nodeType = nodeData?.nodeType || nodeData?.type
  const issues = []
  const name = nodeDisplayName(nodeData, nodeId)

  if (nodeType === 'a2a_agent') {
    for (const [field, label] of [
      ['a2a_poll_interval_seconds', 'poll interval'],
      ['a2a_task_timeout_seconds', 'task timeout'],
    ]) {
      if (!hasField(nodeData, field)) continue
      const value = Number(nodeData[field])
      if (!Number.isFinite(value) || value <= 0) {
        issues.push({
          fields: [field],
          message: `A2A node ${name} ${label} must be greater than 0`,
          short: 'Must be a positive number of seconds.',
        })
      }
    }
    return issues
  }
  if (nodeType === 'tool') return toolNodeIssues(nodeData, name)
  if (nodeType === 'map') return mapNodeIssues(nodeData, name)
  if (nodeType !== 'phase') return issues

  const isDirect = (nodeData?.agent_selection || 'auction') === 'direct'

  // Mirrors the server rule (workflow_definitions.validate_dag) so Save is
  // blocked with an explanation instead of a 400 after the fact. Auction-only:
  // bidders judge fit by reading task_type/description; a direct node already
  // names its agent, so an empty pair just means "system prompt + previous
  // output is the whole instruction".
  if (!isDirect && !nodeData?.task_type && !String(nodeData?.description || '').trim()) {
    issues.push({
      fields: ['task_type', 'description'],
      message: `Phase node ${name} runs an auction but has neither 'task_type' nor 'description' for agents to bid on`,
      short: 'Auction agents decide whether to bid by reading Task Type and Description — give them at least one.',
    })
  }

  if (isDirect && !String(nodeData?.agent_type || '').trim()) {
    issues.push({
      fields: ['agent_type'],
      message: `Phase node ${name} uses direct selection but has no agent selected`,
      short: 'Pick the agent that runs this phase.',
    })
  }

  if (isDirect && !String(nodeData?.phase_label || '').trim()) {
    issues.push({
      fields: ['phase_label'],
      message: `Phase node ${name} uses direct selection but has no phase label`,
      short: "Required when you pick the agent yourself — this names the phase in run progress and is matched against the agent's allowed phases.",
    })
  }

  issues.push(...readsIssues(normalizeContractKeyList(nodeData?.reads), `Phase node ${name}`))

  issues.push(...writesIssues(normalizeContractKeyList(nodeData?.writes), `Phase node ${name}`))

  if (hasField(nodeData, 'max_retries')) {
    const maxRetries = Number(nodeData.max_retries)
    if (!Number.isInteger(maxRetries)) {
      issues.push({
        fields: ['max_retries'],
        message: `Phase node ${name} max_retries must be an integer`,
        short: 'Must be an integer.',
      })
    } else if (maxRetries < 0 || maxRetries > 10) {
      issues.push({
        fields: ['max_retries'],
        message: `Phase node ${name} max_retries must be between 0 and 10`,
        short: 'Must be between 0 and 10.',
      })
    }
  }

  return issues
}

export function getNodeValidationErrors(nodeData = {}, nodeId = '') {
  return getNodeValidationIssues(nodeData, nodeId).map(issue => issue.message)
}

export function getDefaultReadsValidationErrors(defaultReads) {
  const errors = []
  const reads = normalizeContractKeyList(defaultReads)
  if (reads.includes(FULL_CONTEXT_READS_TOKEN) && reads.length > 1) {
    errors.push('Workflow default_reads cannot combine full context with other keys')
  }
  if (reads.includes(WORKFLOW_DEFAULT_READS_TOKEN)) {
    errors.push(`Workflow default_reads cannot use '${WORKFLOW_DEFAULT_READS_TOKEN}'`)
  }
  return errors
}

export function getStaticDelegationValidationErrors(nodes = [], executionMode = 'dynamic') {
  if (String(executionMode || 'dynamic').trim().toLowerCase() !== 'static') return []
  const errors = []
  for (const node of nodes) {
    const nodeType = node?.data?.nodeType || node?.data?.type
    if (nodeType === 'phase' && node.data?.can_delegate === true) {
      errors.push(
        `Static workflows cannot include delegation on phase node ${nodeDisplayName(node.data, node.id)}`,
      )
    }
  }
  return errors
}

export function getWorkflowValidationErrors(nodes = [], defaultReads, executionMode = 'dynamic') {
  return [
    ...getDefaultReadsValidationErrors(defaultReads),
    ...getStaticDelegationValidationErrors(nodes, executionMode),
    ...nodes.flatMap((node) => getNodeValidationErrors(node?.data || {}, node?.id)),
  ]
}
