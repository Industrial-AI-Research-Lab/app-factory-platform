/**
 * Tool journal pairing for the chat feed.
 *
 * Mirrors the backend rule (ADR-0008): a result closes the EARLIEST
 * still-open call with the same (run_id, tool_call_id) — providers may
 * reuse a call id across rounds within one run, so the id alone is
 * ambiguous. Messages must be ascending by sequence (useMessages keeps
 * them sorted).
 */

export function buildToolJournalIndex(messages) {
  const resultByCallMsgId = new Map()
  const pairedResultIds = new Set()
  const openByKey = new Map()
  const seenCallKeys = new Set()

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue
    const callId = m.data?.tool_call_id
    const key = JSON.stringify([m.run_id ?? null, callId])
    if (m.type === 'tool_call') {
      if (!callId) continue
      seenCallKeys.add(key)
      if (!openByKey.has(key)) openByKey.set(key, [])
      openByKey.get(key).push(m)
    } else if (m.type === 'tool_result') {
      const waiting = openByKey.get(key)
      if (waiting && waiting.length) {
        resultByCallMsgId.set(waiting.shift().id, m)
        pairedResultIds.add(m.id)
      } else if (seenCallKeys.has(key)) {
        // Its call is in-window but already closed: the double-delivery
        // duplicate (ADR-0010), not information — suppress it. A result
        // whose call fell outside the window still renders standalone.
        pairedResultIds.add(m.id)
      }
    }
  }

  return { resultByCallMsgId, pairedResultIds }
}

export function toolCallState(result) {
  return result ? (result.status === 'error' ? 'error' : 'ok') : 'awaiting'
}
