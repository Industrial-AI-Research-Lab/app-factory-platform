/**
 * AskHumanCard Component
 *
 * The agent's question to a human, rendered from its tool journal record
 * (ADR-0010): a hanging ask_human tool_call is an open question with an
 * answer box; once the paired tool_result exists the card shows Q+A.
 * Answering POSTs to the human-input route — a live run continues in place,
 * a restarted run resumes from the journal.
 */

import { useState } from 'react'
import { AlertTriangle, HelpCircle, Send, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { apiFetch, formatApiDetail } from '../../utils_api'

function parseQuestion(call) {
  const raw = call?.data?.arguments
  if (raw == null) return ''
  if (typeof raw !== 'string') return raw.question || JSON.stringify(raw)
  // The feed may ship a truncated preview of huge arguments — fall back to
  // showing the raw text rather than nothing.
  try {
    const parsed = JSON.parse(raw)
    return parsed?.question ?? raw
  } catch {
    return raw
  }
}

// A closed pair is an answer only when the tool succeeded; a pair closed by
// an error (bad question, cancelled run) must not render as if a human spoke.
function parseOutcome(result) {
  const raw = result?.data?.result
  if (raw == null) return null
  let parsed = raw
  if (typeof raw === 'string') {
    // tool_result bodies arrive as preview strings (result_is_preview).
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

export default function AskHumanCard({ call, result, projectId }) {
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [notResumed, setNotResumed] = useState(false)
  const [error, setError] = useState(null)

  const question = parseQuestion(call)
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
        `/projects/${projectId}/human-input/${call?.data?.tool_call_id}`,
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
      // The paired tool_result lands in the feed via SSE moments later and
      // flips this card to its answered state; until then show "sent".
      // On the restart path the route also reports whether the workflow
      // actually resumed — false means the answer is recorded but nothing
      // is coming (abnormal run state), so don't promise a resume.
      const body = await resp.json().catch(() => ({}))
      setNotResumed(body?.mode === 'restart' && body?.resumed === false)
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
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-amber-200">
            The agent asks
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
          // Waiting for the paired result to land: show the resume spinner only
          // when the run actually resumed. If it didn't, the latched banner below
          // is the whole message — never a false "resuming…".
          notResumed ? null : (
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              Answer sent — the agent is resuming…
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

        {/* The restart route always writes the answer's tool_result, so `outcome`
            turns non-null within a tick and would bury a notice nested under the
            answered view. Latch it as its own banner so the one signal that says
            "run stalled — resume it manually" survives (ADR-0010). Resets on reload. */}
        {notResumed && (
          <div className="mt-3 flex items-start gap-2 text-sm text-amber-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="whitespace-pre-wrap break-words">
              Answer recorded, but the workflow did not resume automatically — it may
              need a manual resume.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
