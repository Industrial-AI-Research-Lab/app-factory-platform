function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stripJsonCodeFence(content) {
  const trimmed = String(content || '').trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function extractJsonCandidate(content) {
  const asString = String(content || '')
  const stripped = stripJsonCodeFence(asString)
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    return stripped
  }

  const fencedMatch = asString.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  return null
}

function hasAnyKeys(value, keys) {
  if (!isPlainObject(value)) return false
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function getWrappedCandidates(value) {
  const candidates = []
  const queue = [value]
  const seen = new Set()
  const nestedKeys = ['updated_data', 'data', 'payload', 'result', 'message']

  for (let index = 0; index < queue.length && index < 12; index += 1) {
    const current = queue[index]
    if (!current) continue

    if (typeof current === 'object') {
      if (seen.has(current)) continue
      seen.add(current)
    }

    candidates.push(current)
    if (!isPlainObject(current)) continue

    for (const key of nestedKeys) {
      const nested = current[key]
      if (isPlainObject(nested) || Array.isArray(nested)) {
        queue.push(nested)
      }
    }
  }

  return candidates
}

export function detectCardType(value) {
  if (Array.isArray(value)) return 'json'
  if (!isPlainObject(value)) return 'text'

  if (
    value.requirements ||
    value.answered_questions ||
    value.needs_human ||
    value.needs_human_input ||
    value.answered_by_ai ||
    value.questions_answered_by_ai ||
    value.project_type ||
    value.technical_stack ||
    value.functional_requirements ||
    value.non_functional_requirements ||
    value.questions_needing_human ||
    value.questions_answered_by_human
  ) {
    return 'requirements'
  }

  if (
    value.plan ||
    value.tasks ||
    value.phases ||
    value.main_goal ||
    value.goal ||
    value.milestones ||
    value.deliverables
  ) {
    return 'planning'
  }

  if (
    value.artifacts ||
    value.files ||
    value.code ||
    value.execution_result ||
    value.stdout ||
    value.stderr
  ) {
    return 'code_output'
  }

  return 'json'
}

function parseContentValue(content) {
  if (isPlainObject(content) || Array.isArray(content)) {
    return { parsed: content, raw: JSON.stringify(content, null, 2) }
  }

  if (typeof content !== 'string') {
    return { parsed: null, raw: content, parseError: true }
  }

  const candidate = extractJsonCandidate(content)
  if (!candidate) {
    return { parsed: null, raw: content, parseError: true }
  }

  try {
    return { parsed: JSON.parse(candidate), raw: candidate }
  } catch {
    return { parsed: null, raw: content, parseError: true }
  }
}

function pickBestCandidate(parsedValue) {
  const candidates = getWrappedCandidates(parsedValue)
  let genericJson = null

  for (const candidate of candidates) {
    const type = detectCardType(candidate)
    if (type === 'text') continue
    if (type !== 'json') return { type, parsed: candidate }
    if (!genericJson) genericJson = { type, parsed: candidate }
  }

  return genericJson || { type: 'text', parsed: null }
}

export function resolveStructuredMessage(content, hints = {}) {
  const { parsed, raw, parseError } = parseContentValue(content)
  if (!parsed || parseError) {
    return { type: 'text', parsed: null, raw }
  }

  const resolved = pickBestCandidate(parsed)
  if (resolved.type === 'json' && hints?.subtype) {
    const subtype = String(hints.subtype).toLowerCase()
    if (subtype === 'requirements') resolved.type = 'requirements'
    if (subtype === 'plan' || subtype === 'planning') resolved.type = 'planning'
    if (subtype === 'output' || subtype === 'code_output') resolved.type = 'code_output'
  }

  if (resolved.type === 'text' && hasAnyKeys(parsed, ['type', 'status', 'message'])) {
    return { type: 'json', parsed, raw }
  }

  return { ...resolved, raw }
}

export function normalizeRequirementsData(data) {
  if (!isPlainObject(data)) return data
  if (data.requirements && isPlainObject(data.requirements)) return data
  return {
    requirements: data,
    answered_by_ai: data.answered_by_ai || data.answered_questions || data.questions_answered_by_ai || [],
    needs_human_input: data.needs_human_input || data.needs_human || data.questions_needing_human || [],
    inferred_decisions: data.inferred_decisions || {},
  }
}

export function normalizeCodeOutputData(data) {
  if (!isPlainObject(data)) return { artifacts: [] }
  if (Array.isArray(data.artifacts)) return data

  if (Array.isArray(data.files)) {
    return {
      ...data,
      artifacts: data.files.map((file, index) => {
        if (typeof file === 'string') return { path: file, content: '' }
        return {
          path: file?.path || file?.name || `file-${index}.txt`,
          content: file?.content || file?.code || '',
          type: file?.type,
          timestamp: file?.timestamp || file?.created_at,
        }
      }),
    }
  }

  if (typeof data.code === 'string') {
    const language = data?.language || 'txt'
    return {
      ...data,
      artifacts: [{
        path: data?.path || data?.filename || `snippet.${language}`,
        content: data.code,
        type: language,
      }],
    }
  }

  return { ...data, artifacts: [] }
}
