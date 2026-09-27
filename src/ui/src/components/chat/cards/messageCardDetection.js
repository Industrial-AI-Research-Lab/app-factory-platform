import { normalizeResearchPapers } from '../researchHitlUtils.js'

function stripCodeFence(content) {
  if (typeof content !== 'string') return content
  const trimmed = content.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function extractInlineCodeFence(content) {
  if (typeof content !== 'string') return null
  const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return match?.[1]?.trim() || null
}

function extractJsonObjectSlice(content) {
  if (typeof content !== 'string') return null
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return content.slice(start, end + 1).trim()
}

function parseJsonCandidates(candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue
    try {
      return JSON.parse(candidate)
    } catch {
      // Continue to next candidate.
    }
  }
  return null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toPlainObjectArray(value) {
  if (Array.isArray(value)) return value.filter(isPlainObject)
  return isPlainObject(value) ? [value] : []
}

function hasOwn(value, key) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function hasMeaningfulValue(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function hasMeaningfulOwnValue(value, keys) {
  if (!isPlainObject(value)) return false
  return keys.some((key) => hasOwn(value, key) && hasMeaningfulValue(value[key]))
}

function getResearchCandidateObjects(source) {
  if (Array.isArray(source)) return source.filter(isPlainObject)
  if (!isPlainObject(source)) return []
  return [
    ...toPlainObjectArray(source.papers),
    ...toPlainObjectArray(source.metadata?.papers),
    ...toPlainObjectArray(source.results),
    ...toPlainObjectArray(source.items),
  ]
}

function hasExplicitResearchMarker(source) {
  if (!isPlainObject(source)) return false
  return (
    hasOwn(source, 'papers') ||
    hasOwn(source, 'source_route') ||
    hasOwn(source.metadata, 'papers') ||
    hasOwn(source.metadata, 'source_route')
  )
}

function hasPaperLikeFields(candidate) {
  const strongPaperKeys = [
    'doi',
    'openalex_id',
    'pdf_url',
    'pdfUrl',
    'paper_title',
    'publication_year',
    'cited_by_count',
    's3_key',
    'artifact_id',
    'arxiv_id',
    'pmid',
  ]
  if (hasMeaningfulOwnValue(candidate, strongPaperKeys)) return true

  const titleKeys = ['title']
  const bibliographicCompanionKeys = [
    'authors',
    'author',
    'author_string',
    'byline',
    'year',
    'journal',
    'publication_source',
    'venue',
    'source',
    'abstract',
  ]
  return (
    hasMeaningfulOwnValue(candidate, titleKeys) &&
    hasMeaningfulOwnValue(candidate, bibliographicCompanionKeys)
  )
}

function hasResearchPaperDetectionSignal(parsed) {
  if (normalizeResearchPapers({ search_results: parsed }).length === 0) {
    return false
  }
  if (hasExplicitResearchMarker(parsed)) return true
  return getResearchCandidateObjects(parsed).some(hasPaperLikeFields)
}

function guessLanguageFromPath(path) {
  if (typeof path !== 'string') return 'txt'
  const lower = path.toLowerCase()
  if (lower.endsWith('.html')) return 'html'
  if (lower.endsWith('.js')) return 'javascript'
  if (lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.sh')) return 'bash'
  return 'txt'
}

function inferPathFromContext(context) {
  if (typeof context !== 'string' || !context.trim()) return null

  const tickMatches = Array.from(context.matchAll(/`([^`\n]+)`/g))
  for (let i = tickMatches.length - 1; i >= 0; i -= 1) {
    const candidate = tickMatches[i]?.[1]
    if (
      candidate &&
      (/[\\/]/.test(candidate) || /\.[A-Za-z0-9_-]{1,12}$/.test(candidate))
    ) {
      return candidate
    }
  }

  const redirectMatch = context.match(/>\s*([^\s"'`]+(?:\.[A-Za-z0-9_-]{1,12})?)/)
  if (redirectMatch?.[1]) return redirectMatch[1]

  return null
}

function parseMarkdownCodeOutput(content) {
  if (typeof content !== 'string') return null

  const codeBlockRegex = /```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g
  const artifacts = []
  let match

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = (match[1] || '').trim().toLowerCase()
    const blockContent = (match[2] || '').trim()
    if (!blockContent) continue

    const contextWindowStart = Math.max(0, match.index - 220)
    const contextBeforeBlock = content.slice(contextWindowStart, match.index)
    const isShellBlock =
      language === 'bash' || language === 'sh' || language === 'shell'
    const inferredPath = isShellBlock ? null : inferPathFromContext(contextBeforeBlock)

    let path = inferredPath
    let type = language || guessLanguageFromPath(path)

    if (!path) {
      if (isShellBlock) {
        path = 'commands.sh'
        type = 'bash'
      } else if (language) {
        path = `snippet.${language}`
        type = language
      } else {
        path = `snippet-${artifacts.length + 1}.txt`
        type = 'txt'
      }
    } else if (!type) {
      type = guessLanguageFromPath(path)
    }

    artifacts.push({
      path,
      content: blockContent,
      type,
    })
  }

  if (artifacts.length === 0) return null

  return {
    artifacts,
    code_blocks: artifacts.length,
    message: content,
  }
}

export function parseStructuredContent(content) {
  if (content && typeof content === 'object') return content
  if (typeof content !== 'string') return null

  const normalized = stripCodeFence(content)
  if (!normalized) return null

  const inlineFence = extractInlineCodeFence(content)
  const objectSlice = extractJsonObjectSlice(normalized)

  const jsonParsed = parseJsonCandidates([
    normalized,
    inlineFence,
    objectSlice,
  ])

  if (jsonParsed) return jsonParsed

  return parseMarkdownCodeOutput(content)
}

export function shouldRenderAsCodeFallback(content) {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  if (!trimmed) return false

  if (/^```/i.test(trimmed)) return true
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true
  if (/^requirements[_\s-]/i.test(trimmed) && trimmed.includes('{')) return true

  return false
}

export function detectCardType(content) {
  const parsed = parseStructuredContent(content)
  if (!parsed || typeof parsed !== 'object') return 'text'

  if (
    parsed.answered_questions ||
    parsed.questions_answered_by_ai ||
    parsed.questions_needing_human ||
    parsed.needs_human ||
    parsed.project_type ||
    parsed.technical_stack ||
    parsed.functional_requirements ||
    parsed.non_functional_requirements ||
    parsed.inferred_decisions ||
    parsed.clarity_score != null ||
    (parsed.analysis && (parsed.questions || parsed.status || parsed.user_prompt))
  ) {
    return 'requirements'
  }

  if (parsed.plan || parsed.tasks || parsed.phases) {
    return 'planning'
  }

  if (
    parsed.deploy_status ||
    parsed.deployment_status ||
    parsed.deployment ||
    (Object.prototype.hasOwnProperty.call(parsed, 'url') &&
      Object.prototype.hasOwnProperty.call(parsed, 'needs_delegation'))
  ) {
    return 'deploy'
  }

  if (parsed.code || parsed.files || parsed.artifacts) {
    return 'code_output'
  }

  if (hasResearchPaperDetectionSignal(parsed)) {
    return 'research_papers'
  }

  return 'json'
}
