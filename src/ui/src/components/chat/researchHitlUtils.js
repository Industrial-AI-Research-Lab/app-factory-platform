function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toArray(value) {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function firstStringList(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const items = value.map((item) => (
        isPlainObject(item)
          ? firstString(item.name, item.display_name, item.title)
          : firstString(item)
      )).filter(Boolean)
      if (items.length > 0) return items.join(', ')
    }
    const text = firstString(value)
    if (text) return text
  }
  return ''
}

function parseJsonValuesFromString(value) {
  const text = value.trim()
  if (!text) return []

  try {
    return [JSON.parse(text)]
  } catch {
    // Some MCP tools return multiple JSON values concatenated, e.g. "[...][...]".
  }

  const values = []
  let start = -1
  let depth = 0
  let inString = false
  let escape = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (start === -1) {
      if (/\s/.test(char)) continue
      if (char !== '[' && char !== '{') return []
      start = index
      depth = 1
      inString = false
      escape = false
      continue
    }

    if (inString) {
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '[' || char === '{') {
      depth += 1
    } else if (char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          return []
        }
        start = -1
      }
    }
  }

  return start === -1 ? values : []
}

function getSnapshot(data) {
  return isPlainObject(data?.context_snapshot) ? data.context_snapshot : {}
}

function getNestedPapers(source) {
  if (typeof source === 'string') {
    return parseJsonValuesFromString(source).flatMap(getNestedPapers)
  }
  if (Array.isArray(source)) return source.filter(isPlainObject)
  if (!isPlainObject(source)) return []
  return [
    ...toArray(source.papers),
    ...toArray(source.metadata?.papers),
    ...toArray(source.results),
    ...toArray(source.items),
  ].filter(isPlainObject)
}

function paperIdentity(raw, index) {
  return firstString(
    raw.id,
    raw.openalex_id,
    raw.doi,
    raw.s3_key,
    raw.artifact_id,
    raw.pdf_url,
    raw.url,
    raw.title,
    raw.paper_title,
    `paper-${index + 1}`,
  )
}

function normalizePaper(raw, index) {
  const title = firstString(raw.title, raw.paper_title, raw.name, `Paper ${index + 1}`)
  return {
    id: paperIdentity(raw, index),
    title,
    authors: firstStringList(raw.authors, raw.author, raw.author_string, raw.byline),
    doi: firstString(raw.doi),
    year: firstString(raw.publication_year, raw.year),
    source: firstString(raw.source, raw.journal, raw.publication_source, raw.venue),
    summary: firstString(raw.summary, raw.abstract, raw.answer, raw.description),
    pdfUrl: firstString(raw.pdf_url, raw.pdfUrl, raw.url),
    storageRef: firstString(raw.s3_key, raw.s3Key, raw.artifact_id, raw.path),
    citedByCount: firstString(raw.cited_by_count),
    raw,
  }
}

export function normalizeResearchPapers(data) {
  const snapshot = getSnapshot(data)
  const sources = [
    data?.literature,
    snapshot.literature,
    data?.search_results,
    snapshot.search_results,
    data?.research_answer,
    snapshot.research_answer,
  ]

  const seen = new Set()
  const papers = []
  for (const source of sources) {
    for (const rawPaper of getNestedPapers(source)) {
      const normalized = normalizePaper(rawPaper, papers.length)
      const key = normalized.id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      papers.push(normalized)
    }
  }
  return papers
}

export function getResearchAnswer(data) {
  const snapshot = getSnapshot(data)
  const candidates = [
    data?.literature,
    snapshot.literature,
    data?.research_answer,
    snapshot.research_answer,
    data?.search_results,
    snapshot.search_results,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      if (getNestedPapers(candidate).length > 0) continue
      return candidate.trim()
    }
    if (isPlainObject(candidate)) {
      const answer = firstString(candidate.answer, candidate.summary, candidate.result, candidate.output)
      if (answer) return answer
    }
  }
  return ''
}

export function getResearchQuestion(data) {
  const snapshot = getSnapshot(data)
  return firstString(
    snapshot.user_prompt,
    snapshot.requirements?.user_prompt,
    data?.user_prompt,
    data?.requirements?.user_prompt,
  )
}

export function hasResearchReviewPayload(data) {
  const snapshot = getSnapshot(data)
  const candidates = [
    data?.literature,
    snapshot.literature,
    data?.research_answer,
    snapshot.research_answer,
    data?.search_results,
    snapshot.search_results,
    data?.approved_literature,
    snapshot.approved_literature,
  ]

  return candidates.some((candidate) => {
    if (typeof candidate === 'string') return candidate.trim().length > 0
    if (Array.isArray(candidate)) return candidate.length > 0
    if (!isPlainObject(candidate)) return false
    if (getNestedPapers(candidate).length > 0) return true
    return Boolean(firstString(candidate.answer, candidate.summary, candidate.result, candidate.output))
  })
}

export function getResearchRoute(data) {
  const snapshot = getSnapshot(data)
  const route = (
    data?.literature?.source_route ||
    snapshot.literature?.source_route ||
    data?.search_results?.metadata?.source_route ||
    snapshot.search_results?.metadata?.source_route ||
    data?.research_answer?.source_route ||
    snapshot.research_answer?.source_route
  )
  return toArray(route).map(String).filter(Boolean)
}

export function buildResearchInteractionResponse({
  interactionType,
  decision,
  selectedPaperIds = [],
  downloadSelected = false,
  requireSources = false,
  feedbackText = '',
}) {
  return {
    interaction_type: interactionType,
    decision,
    selected_paper_ids: selectedPaperIds,
    download_selected: Boolean(downloadSelected),
    require_sources: Boolean(requireSources),
    feedback_text: feedbackText.trim(),
  }
}

export function buildResearchRefineFeedback({
  interactionType,
  decision,
  selectedPapers = [],
  feedbackText = '',
  downloadSelected = false,
  requireSources = false,
}) {
  const heading = interactionType === 'research_answer_review'
    ? 'Research answer review feedback:'
    : 'Literature review feedback:'
  const selectedText = selectedPapers.length
    ? selectedPapers.map((paper) => `- ${paper.id}: ${paper.title}`).join('\n')
    : '- none selected'
  return [
    heading,
    `Decision: ${decision}`,
    interactionType === 'literature_selection_review' ? `Selected papers:\n${selectedText}` : '',
    interactionType === 'literature_selection_review' ? `Download selected PDFs: ${downloadSelected ? 'yes' : 'no'}` : '',
    interactionType === 'research_answer_review' ? `Require more sources: ${requireSources ? 'yes' : 'no'}` : '',
    feedbackText.trim() ? `Requested changes:\n${feedbackText.trim()}` : '',
  ].filter(Boolean).join('\n\n')
}
