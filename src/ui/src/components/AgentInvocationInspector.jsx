/**
 * AgentInvocationInspector
 *
 * Modal drill-down for a single captured LLM invocation. Four tabs:
 *   - Conversation:    input messages with role labels (incl. prior tool
 *                      calls + their results)
 *   - System Prompt:   effective system prompt sent this turn
 *   - Available Tools: JSON of tool schemas exactly as passed to the LLM API
 *                      (what the model COULD call — not calls made)
 *   - Response:        thinking + text + tool_uses + stop_reason + usage
 *
 * Pure-read: opens a fresh GET on mount, never re-runs the LLM call.
 * Backend surface: api/routes/agent_llm_calls.py.
 */

import { useEffect, useState } from 'react'
import { X, Loader2, AlertTriangle, Flag, MessageSquare, Brain, Copy, Check, ChevronLeft, ChevronRight, FileText, Wrench } from 'lucide-react'
import { apiFetch } from '../utils_api'

const TABS = [
  { id: 'messages', label: 'Conversation', icon: MessageSquare },
  { id: 'system', label: 'System Prompt', icon: FileText },
  { id: 'tools', label: 'Available Tools', icon: Wrench },
  { id: 'response', label: 'Response', icon: Brain },
]

// Recursively inline embedded JSON strings. Tool outputs are captured as a
// JSON STRING nested inside the message object (sometimes doubly), and when
// serialized with ensure_ascii=True the Cyrillic became \uXXXX. Parsing each
// JSON-looking string decodes those escapes AND expands the nesting for reading.
function decodeEmbeddedJson(v, depth = 0) {
  if (depth > 6) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.length >= 2 && (t[0] === '{' || t[0] === '[')) {
      try { return decodeEmbeddedJson(JSON.parse(t), depth + 1) } catch { return v }
    }
    return v
  }
  if (Array.isArray(v)) return v.map(x => decodeEmbeddedJson(x, depth + 1))
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v)) out[k] = decodeEmbeddedJson(v[k], depth + 1)
    return out
  }
  return v
}

function JsonBlock({ value, max = 8000 }) {
  if (value == null) return <span className="text-slate-500 italic">null</span>
  let text
  try {
    const decoded = decodeEmbeddedJson(value)
    text = typeof decoded === 'string' ? decoded : JSON.stringify(decoded, null, 2)
  } catch {
    text = String(value)
  }
  const truncated = text.length > max
  const view = truncated ? text.slice(0, max) + `\n…(${text.length - max} more chars)` : text
  return (
    <pre className="whitespace-pre-wrap break-words text-xs font-mono bg-slate-950 border border-slate-800 rounded p-3 text-slate-300 max-h-[60vh] min-h-[3rem] overflow-y-auto resize-y">
      {view}
    </pre>
  )
}

function RoleLabel({ role }) {
  const color = {
    system: 'bg-amber-900/50 text-amber-200 border-amber-700/40',
    user: 'bg-blue-900/50 text-blue-200 border-blue-700/40',
    assistant: 'bg-purple-900/50 text-purple-200 border-purple-700/40',
    tool: 'bg-emerald-900/50 text-emerald-200 border-emerald-700/40',
  }[role] || 'bg-slate-800 text-slate-300 border-slate-700'
  return (
    <span className={`text-xs px-2 py-0.5 rounded border uppercase tracking-wide ${color}`}>
      {role || 'item'}
    </span>
  )
}

function MessageItem({ item, idx }) {
  if (!item || typeof item !== 'object') {
    return <JsonBlock value={item} />
  }
  const role = item.role
  const type = item.type
  const content = item.content
  const label = role || type || `item-${idx}`
  let body = content
  if (body == null) {
    const { role: _r, type: _t, content: _c, ...rest } = item
    body = rest
  }
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1">
        <RoleLabel role={label} />
        {type && role && <span className="text-xs text-slate-500">{type}</span>}
      </div>
      <JsonBlock value={body} />
    </div>
  )
}

function SystemPromptTab({ doc }) {
  const req = doc?.request || {}
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">System prompt</h4>
      {req.system ? <JsonBlock value={req.system} max={20000} /> : <span className="text-slate-500 italic text-sm">(no system message)</span>}
    </div>
  )
}

function ConversationTab({ doc }) {
  const req = doc?.request || {}
  const messages = Array.isArray(req.messages) ? req.messages : []
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
        Input messages <span className="text-slate-500 normal-case">({messages.length})</span>
      </h4>
      <div className="text-xs text-slate-500 mb-2">
        Everything sent to the model this turn — including tool calls and tool results from previous turns.
      </div>
      {messages.length === 0 ? (
        <span className="text-slate-500 italic text-sm">(no input messages)</span>
      ) : (
        messages.map((m, i) => <MessageItem key={i} item={m} idx={i} />)
      )}
    </div>
  )
}

// Tools may be stored as a truncation placeholder when the schemas blow the
// 200KB doc cap: [{_truncated, _original_count, _original_bytes, _names?}].
// Resolve the real count + the truncated marker once, reused by the chip strip,
// the copy summary, and ToolsTab.
function toolsInfo(req) {
  const arr = Array.isArray(req?.tools) ? req.tools : null
  const trunc = arr && arr.length === 1 && arr[0] && arr[0]._truncated ? arr[0] : null
  const count = trunc ? (trunc._original_count || 0) : (arr ? arr.length : 0)
  return { arr, trunc, count }
}

// One-line disambiguation shown at the top of the Available Tools tab —
// this tab kept being read as a call log (it is the request's tool schemas).
function ToolsTabHint() {
  return (
    <div className="text-xs text-slate-500">
      Tool schemas attached to this request — what the model <span className="text-slate-300">could</span> call,
      not calls made. Calls made are in Response; their results arrive in the next turn's Conversation.
    </div>
  )
}

function ToolsTab({ doc }) {
  const { arr, trunc, count } = toolsInfo(doc?.request)
  if (!arr || arr.length === 0) {
    return <div className="text-slate-500 italic text-sm">(no tools available to this invocation)</div>
  }
  if (trunc) {
    const names = Array.isArray(trunc._names) ? trunc._names : []
    const kb = Math.round((trunc._original_bytes || 0) / 1024)
    return (
      <div className="space-y-3">
        <ToolsTabHint />
        <div className="text-xs text-amber-300">
          {count} tool{count === 1 ? '' : 's'} available — full schemas dropped to fit the 200KB cap ({kb} KB).
        </div>
        {names.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {names.map((n, i) => (
              <span key={i} className="text-xs font-mono px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/70 text-slate-300">
                {n}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-slate-500 italic text-sm">(tool names unavailable — capture predates the names fix)</div>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <ToolsTabHint />
      <div className="text-xs text-slate-400">
        {count} tool{count === 1 ? '' : 's'} available
      </div>
      <JsonBlock value={arr} max={50000} />
    </div>
  )
}

function ResponseTab({ doc }) {
  const resp = doc?.response || {}
  const usage = resp.usage || null
  const toolUses = Array.isArray(resp.tool_uses) ? resp.tool_uses : []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-slate-900/50 border border-slate-800 rounded p-2">
          <div className="text-slate-500">stop_reason</div>
          <div className="text-slate-200 font-mono">{resp.stop_reason || '—'}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded p-2">
          <div className="text-slate-500">usage</div>
          <div className="text-slate-200 font-mono break-words">
            {usage ? JSON.stringify(usage) : '—'}
          </div>
        </div>
      </div>

      {resp.error && (
        <div className="border border-red-700/50 bg-red-900/20 rounded p-3">
          <div className="text-xs uppercase tracking-wide text-red-300 mb-1">error</div>
          <div className="text-sm text-red-200 font-mono whitespace-pre-wrap">{resp.error}</div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Thinking</h4>
        {resp.thinking ? <JsonBlock value={resp.thinking} max={20000} /> : <span className="text-slate-500 italic text-sm">(no thinking content)</span>}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Text</h4>
        {resp.text ? <JsonBlock value={resp.text} max={20000} /> : <span className="text-slate-500 italic text-sm">(no text content)</span>}
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
          Tool uses <span className="text-slate-500 normal-case">({toolUses.length})</span>
        </h4>
        {toolUses.length === 0 ? (
          <span className="text-slate-500 italic text-sm">(no tool calls)</span>
        ) : (
          toolUses.map((tc, i) => (
            <div key={tc.id || i} className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-emerald-300">{tc.name || '(unnamed)'}</span>
                {tc.id && <span className="text-xs text-slate-500 font-mono">{tc.id}</span>}
              </div>
              <JsonBlock value={tc.input} max={8000} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function buildCopySummary(doc) {
  if (!doc) return ''
  const req = doc.request || {}
  const params = req.params || {}
  const summary = {
    agent: doc.agent_id ?? null,
    model: doc.model ?? null,
    turn_index: doc.turn_index ?? null,
    temperature: req.temperature ?? null,
    reasoning_effort: params.reasoning_effort ?? null,
    max_tokens: req.max_tokens ?? null,
    tools_available: toolsInfo(req).count,
    task_id: doc.task_id ?? null,
    call_id: doc._id ?? null,
    started_at: doc.started_at ?? null,
  }
  return JSON.stringify(summary, null, 2)
}

export default function AgentInvocationInspector({ callId, rounds = null, onClose }) {
  // currentCallId lets the user page through an agent's rounds without closing.
  const [currentCallId, setCurrentCallId] = useState(callId)
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('messages')
  const [flagging, setFlagging] = useState(false)
  const [copied, setCopied] = useState(false)

  // Re-sync when the modal is (re)opened for a different invocation.
  useEffect(() => { setCurrentCallId(callId) }, [callId])

  useEffect(() => {
    if (!currentCallId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setDoc(null)
    apiFetch(`/agent-llm-calls/${currentCallId}`)
      .then(res => {
        if (!res.ok) {
          if (res.status === 404) throw new Error('capturing')
          return res.json().then(j => { throw new Error(j?.detail || `HTTP ${res.status}`) })
        }
        return res.json()
      })
      .then(d => {
        if (!cancelled) {
          setDoc(d)
          setLoading(false)
        }
      })
      .catch(e => {
        if (!cancelled) {
          setError(e.message)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [currentCallId])

  // Round-nav derivations. Plain (safe before the early return); goPrev/goNext
  // live below since they're only used in JSX.
  const roundList = Array.isArray(rounds) ? rounds : []
  const roundIdx = roundList.findIndex(r => r && r.callId === currentCallId)
  const hasNav = roundList.length > 1 && roundIdx >= 0

  // Keyboard ←/→ pages rounds without leaving the modal.
  useEffect(() => {
    if (!hasNav) return
    const onKey = (e) => {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft' && roundIdx > 0) {
        e.preventDefault()
        setCurrentCallId(roundList[roundIdx - 1].callId)
      } else if (e.key === 'ArrowRight' && roundIdx < roundList.length - 1) {
        e.preventDefault()
        setCurrentCallId(roundList[roundIdx + 1].callId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasNav, roundIdx, roundList])

  const handleFlag = async () => {
    if (!currentCallId || flagging) return
    setFlagging(true)
    try {
      const res = await apiFetch(`/agent-llm-calls/${currentCallId}/flag`, { method: 'POST' })
      if (res.ok) {
        setDoc(prev => prev ? { ...prev, flagged: true } : prev)
      }
    } finally {
      setFlagging(false)
    }
  }

  const handleCopySummary = async () => {
    const text = buildCopySummary(doc)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable in non-secure contexts; silently no-op.
    }
  }

  if (!callId) return null

  const usage = doc?.response?.usage
  const truncated = !!doc?.truncated
  const flagged = !!doc?.flagged

  const goPrev = () => { if (roundIdx > 0) setCurrentCallId(roundList[roundIdx - 1].callId) }
  const goNext = () => { if (roundIdx >= 0 && roundIdx < roundList.length - 1) setCurrentCallId(roundList[roundIdx + 1].callId) }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-100 shrink-0">Invocation Inspector</h2>
            {doc && (
              <span className="text-xs text-slate-400 font-mono truncate min-w-0" title={doc.agent_id}>
                {doc.agent_id}
              </span>
            )}
            {hasNav ? (
              <span className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={goPrev}
                  disabled={roundIdx <= 0}
                  className="p-0.5 rounded hover:bg-slate-700 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  title="Previous round"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-slate-400 font-mono">
                  turn {roundList[roundIdx]?.turnIndex ?? roundIdx}
                  <span className="text-slate-600"> ({roundIdx + 1}/{roundList.length})</span>
                </span>
                <button
                  onClick={goNext}
                  disabled={roundIdx >= roundList.length - 1}
                  className="p-0.5 rounded hover:bg-slate-700 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  title="Next round"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </span>
            ) : (
              doc && (
                <span className="text-xs text-slate-500 font-mono shrink-0">
                  · turn {doc.turn_index} ·
                </span>
              )
            )}
            {doc && (
              <span className="text-xs text-slate-300 font-mono shrink-0 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700" title={doc.model || 'model?'}>
                {doc.model || 'model?'}
              </span>
            )}
            {truncated && (
              <span className="text-xs px-1.5 py-0.5 rounded border text-amber-300 border-amber-500/40 bg-amber-900/20 shrink-0" title="Doc exceeded 200KB; some fields stored as placeholders">
                truncated
              </span>
            )}
            {flagged && (
              <span className="text-xs px-1.5 py-0.5 rounded border text-emerald-300 border-emerald-500/40 bg-emerald-900/20 shrink-0" title="Pinned — this capture will NOT be auto-deleted after the 30-day TTL">
                flagged
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {doc && (
              <button
                onClick={handleCopySummary}
                className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1 text-slate-300"
                title="Copy invocation summary (agent, model, temperature, reasoning_effort, tools count, task_id, call_id) to clipboard"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy summary'}
              </button>
            )}
            {doc && !flagged && (
              <button
                onClick={handleFlag}
                disabled={flagging}
                className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1 text-slate-300 disabled:opacity-50"
                title="Pin this capture so it is NOT auto-deleted by the 30-day TTL. Use when you want to keep a specific invocation around for later inspection or as a regression reference."
              >
                <Flag className="w-3 h-3" /> Pin (keep)
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Run-config strip */}
        {doc && (() => {
          const req = doc.request || {}
          const params = req.params || {}
          const toolsCount = toolsInfo(req).count
          const chips = [
            { label: 'temp', value: req.temperature != null ? String(req.temperature) : 'default' },
            { label: 'reasoning', value: params.reasoning_effort != null ? String(params.reasoning_effort) : 'default' },
            { label: 'max_tokens', value: req.max_tokens != null ? String(req.max_tokens) : 'no cap' },
            { label: 'tools available', value: String(toolsCount) },
          ]
          return (
            <div className="flex items-center gap-2 px-5 py-1.5 border-b border-slate-800 bg-slate-900/40 overflow-x-auto">
              {chips.map(c => (
                <span key={c.label} className="text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/70 text-slate-300">
                  <span className="text-slate-500">{c.label}=</span>{c.value}
                </span>
              ))}
            </div>
          )
        })()}

        {/* Tabs */}
        <div className="flex border-b border-slate-700 px-5">
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 transition-colors ${
                  active
                    ? 'border-blue-500 text-blue-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            )
          })}
          {usage && (
            <div className="ml-auto flex items-center gap-3 text-xs text-slate-400 py-2 font-mono">
              {typeof usage.prompt_tokens === 'number' && <span>in {usage.prompt_tokens}</span>}
              {typeof usage.completion_tokens === 'number' && <span>out {usage.completion_tokens}</span>}
              {typeof usage.total_tokens === 'number' && <span>total {usage.total_tokens}</span>}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading capture…
            </div>
          )}
          {error === 'capturing' && (
            <div className="text-slate-400 text-sm">
              (capturing…) — the capture doc hasn't landed yet. The agent run may still be in flight.
            </div>
          )}
          {error && error !== 'capturing' && (
            <div className="flex items-center gap-2 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4" /> {error}
            </div>
          )}
          {doc && !loading && (
            <>
              {tab === 'messages' && <ConversationTab doc={doc} />}
              {tab === 'system' && <SystemPromptTab doc={doc} />}
              {tab === 'tools' && <ToolsTab doc={doc} />}
              {tab === 'response' && <ResponseTab doc={doc} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
