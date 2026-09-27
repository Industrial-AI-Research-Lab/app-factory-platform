/**
 * A2AInputRequiredCard Component
 *
 * A question from the external A2A agent's task reaching TASK_STATE_INPUT_REQUIRED
 * (AppFactory-281), rendered from its tool journal record — same journal shape
 * AskHumanCard reads (an open tool_call is an open question with an answer box;
 * a paired tool_result shows Q+A), but this is a DIFFERENT subsystem: the
 * question is a durable a2a_task_state cursor at "awaiting_human", not an
 * in-process ask_human wait, and answering it POSTs to the a2a-specific route,
 * which continues the SAME A2A task_id (message/send) rather than closing an
 * ask_human pair. No time limit on answering — the pause survives a backend
 * restart via the cursor, not this component.
 */

import { useState } from 'react'
import { HelpCircle, Send, CheckCircle, XCircle, Loader2, AlertTriangle } from 'lucide-react'
import { apiFetch, formatApiDetail } from '../../utils_api'

function parseQuestion(call) {
  const raw = call?.data?.arguments
  if (raw == null) return {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return { question: raw }
  }
}

function parseOutcome(result) {
  const raw = result?.data?.result
  if (raw == null) return null
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { failed: false, text: raw }
    }
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.status === 'error') {
      return { failed: true, text: parsed.error || 'closed without an answer' }
    }
    return { failed: false, text: parsed.answer ?? JSON.stringify(parsed) }
  }
  return { failed: false, text: String(parsed) }
}

export default function A2AInputRequiredCard({ call, result, projectId }) {
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [notResumed, setNotResumed] = useState(false)
  const [error, setError] = useState(null)

  const parsed = parseQuestion(call)
  const question = parsed.question || ''
  const agentName = parsed.agent_name
  const role = parsed.role
  const step = parsed.step
  const subtitleParts = [agentName, role, step].filter(Boolean)
  const outcome = parseOutcome(result)
  const timestamp = call?.created_at
    ? new Date(call.created_at).toLocaleTimeString()
    : null

  const submit = async () => {
    const text = answer.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const resp = await apiFetch(
        `/projects/${projectId}/a2a-human-input/${call?.data?.tool_call_id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: text }),
        }
      )
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(formatApiDetail(body?.detail))
      }
      const body = await resp.json().catch(() => ({}))
      setNotResumed(body?.resumed === false)
      setSent(true)
    } catch (e) {
      setError(e?.message || 'Failed to send the answer')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex items-start gap-3 p-4 rounded-lg border bg-amber-950/20 border-amber-700/40">
      <HelpCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-amber-400" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-amber-200">
            {subtitleParts.length > 0
              ? `${subtitleParts.join(' · ')} asks`
              : 'The external agent asks'}
          </span>
          {timestamp && <span className="text-xs text-slate-500">{timestamp}</span>}
        </div>
        <div className="mt-1 text-sm text-slate-200 whitespace-pre-wrap break-words">
          {question}
        </div>

        {outcome != null ? (
          <div className="mt-3 flex items-start gap-2 text-sm">
            {outcome.failed
              ? <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" />
              : <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-400" />}
            <div className="text-slate-300 whitespace-pre-wrap break-words">
              {outcome.text}
            </div>
          </div>
        ) : sent ? (
          notResumed ? null : (
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              Answer sent — resuming the task…
            </div>
          )
        ) : (
          <div className="mt-3">
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
              placeholder="Type your answer…"
              rows={2}
              disabled={sending}
              className="w-full text-sm rounded-md bg-slate-900/70 border border-slate-700 text-slate-200 p-2 focus:outline-none focus:border-amber-500 disabled:opacity-60"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={submit}
                disabled={sending || !answer.trim()}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Send className="w-3.5 h-3.5" />}
                Answer
              </button>
              {error && <span className="text-xs text-red-400">{error}</span>}
            </div>
          </div>
        )}

        {notResumed && (
          <div className="mt-3 flex items-start gap-2 text-sm text-amber-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="whitespace-pre-wrap break-words">
              Answer recorded, but the task did not resume automatically — it may
              need a manual resume.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
