import { useState } from 'react'

// "__default____coscientist_planner@proj-id" -> "coscientist_planner"
function cleanAgent(id) {
  let s = String(id || '')
  s = s.split('@')[0]
  const idx = s.lastIndexOf('__')
  if (idx >= 0) s = s.slice(idx + 2)
  return s || 'agent'
}

function formatOutput(output) {
  if (output == null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

/**
 * AppFactory-154 — transient card for a human-in-the-loop delegation review gate.
 * The gate is ephemeral (not in the messages collection); the parent drives it
 * from the live `approval_requested` SSE event and supplies onApprove/onReject,
 * which resolve the approval by its approval_id.
 */
export default function DelegationApprovalCard({ approval, onApprove, onReject }) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const gate = approval?.data?.data || {}
  const dele = gate.delegation || {}
  const child = cleanAgent(dele.child_agent)
  const attempt = Number(dele.attempt || 0)
  const output = formatOutput(dele.output)

  const doApprove = async () => {
    if (busy) return
    setBusy(true)
    try { await onApprove?.() } finally { setBusy(false) }
  }
  const doReject = async () => {
    if (busy) return
    setBusy(true)
    try { await onReject?.(reason.trim()) } finally {
      setBusy(false); setRejecting(false); setReason('')
    }
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-slate-800/95 shadow-lg p-3 text-sm backdrop-blur">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-amber-300 font-medium">Delegation review</span>
        <span className="text-slate-500">·</span>
        <span className="text-slate-100">{child}</span>
        {attempt > 0 && (
          <span className="text-[11px] text-amber-300/80 rounded bg-amber-500/10 px-1.5 py-0.5">revision {attempt}</span>
        )}
      </div>
      <div className="text-xs text-slate-400 mb-2">
        The orchestrator delegated to <span className="text-slate-200">{child}</span>. Review its
        result before it continues.
      </div>
      {output && (
        <pre className="max-h-56 overflow-auto rounded bg-slate-900/70 border border-slate-700 p-2 text-xs text-slate-200 whitespace-pre-wrap break-words">{output}</pre>
      )}
      {!rejecting ? (
        <div className="flex gap-2 mt-3">
          <button
            disabled={busy}
            onClick={doApprove}
            className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50"
          >Approve</button>
          <button
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-medium disabled:opacity-50"
          >Reject…</button>
        </div>
      ) : (
        <div className="mt-3">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What should the agent change? (sent back as feedback for a retry)"
            className="w-full rounded bg-slate-900/70 border border-slate-700 p-2 text-xs text-slate-100 outline-none focus:border-amber-500/50"
          />
          <div className="flex gap-2 mt-2">
            <button
              disabled={busy}
              onClick={doReject}
              className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium disabled:opacity-50"
            >Send rejection</button>
            <button
              disabled={busy}
              onClick={() => { setRejecting(false); setReason('') }}
              className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs disabled:opacity-50"
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
