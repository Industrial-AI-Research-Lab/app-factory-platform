import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function labelFor(key) {
  return String(key || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function Primitive({ value }) {
  if (value == null) {
    return <span className="text-slate-500 italic">No data</span>
  }
  if (typeof value === 'boolean') {
    return <span className="text-slate-200">{value ? 'Yes' : 'No'}</span>
  }
  return <span className="text-slate-200 break-words">{String(value)}</span>
}

function parseStructured(value) {
  // Agents routinely hand back their result as a JSON string — e.g. the
  // finalizers' { final_output: "{ ...json... }" }. Render it as the structured
  // object so its fields show as sections, but only when it cleanly parses to
  // an object/array; plain prose and stray "{…}" fragments stay markdown.
  const trimmed = value.trim()
  if (trimmed.length < 2 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function ResultValue({ value, depth = 0 }) {
  if (typeof value === 'string') {
    const structured = parseStructured(value)
    if (structured !== undefined) {
      return <ResultValue value={structured} depth={depth} />
    }
    return (
      <div className="prose prose-invert prose-sm max-w-none text-slate-200 break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
      </div>
    )
  }
  if (value == null || typeof value !== 'object') {
    return <Primitive value={value} />
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-slate-500 italic">No items</span>
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div
            key={index}
            className="rounded-lg border border-slate-700 bg-slate-900/60 p-3"
          >
            <ResultValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value)
  if (entries.length === 0) {
    return <span className="text-slate-500 italic">No fields</span>
  }
  return (
    <div className="space-y-3">
      {entries.map(([key, item]) => (
        <div key={key} className={depth ? '' : 'rounded-lg bg-slate-900/40 p-3'}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {labelFor(key)}
          </div>
          <ResultValue value={item} depth={depth + 1} />
        </div>
      ))}
    </div>
  )
}

export default function AgentResultDisplay({ data }) {
  const result = data?.agent_result || {}
  const name = result.agent_display_name || result.agent_id || 'Agent'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-400">Agent:</span>
        <span className="font-medium text-slate-100">{name}</span>
        {Number.isInteger(result.attempt) && (
          <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-400">
            Attempt {result.attempt + 1}
          </span>
        )}
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-xl border border-slate-700 bg-slate-950/70 p-4">
        <ResultValue value={result.output} />
      </div>
    </div>
  )
}
