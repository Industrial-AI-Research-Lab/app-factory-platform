/**
 * useAgentInvocations Hook
 *
 * Indexes `agent.invocation.captured` events for fast thought→callId lookup
 * by the Agent Invocation Inspector (AgentInvocationInspector.jsx).
 *
 * Pure derivation: takes the same `events` array ChatInterface already
 * receives from the project SSE stream — no new connection.
 */

import { useMemo } from 'react'

const EVENT_TYPE = 'agent.invocation.captured'

function buildCapture(event) {
  const d = event?.data || {}
  if (!d.call_id) return null
  return {
    callId: d.call_id,
    agentId: d.agent_id || null,
    runId: d.run_id || null,
    taskId: d.task_id || null,
    turnIndex: typeof d.turn_index === 'number' ? d.turn_index : null,
    tokenCounts: d.token_counts || null,
    stopReason: d.stop_reason || null,
    truncated: !!d.truncated,
    timestamp: event?.timestamp || null,
  }
}

export function useAgentInvocations(events) {
  return useMemo(() => {
    const byKey = new Map()
    const byCallId = new Map()
    if (!Array.isArray(events) || events.length === 0) {
      return { byKey, byCallId, count: 0 }
    }
    for (const e of events) {
      if (e?.type !== EVENT_TYPE) continue
      const cap = buildCapture(e)
      if (!cap) continue
      byCallId.set(cap.callId, cap)
      const k = `${cap.agentId || '_'}|${cap.turnIndex ?? -1}`
      const arr = byKey.get(k) || []
      arr.push(cap)
      byKey.set(k, arr)
    }
    return { byKey, byCallId, count: byCallId.size }
  }, [events])
}

/**
 * Resolve the best capture for a thought, identified by (agentId, round).
 * `round` is 1-based on the thought bubble; turn_index is 0-based.
 * If multiple captures share the same key (retries), the newest wins.
 */
export function resolveCaptureForThought(invocations, agentId, round) {
  if (!invocations?.byKey || !agentId || typeof round !== 'number') return null
  const turnIndex = round - 1
  const list = invocations.byKey.get(`${agentId}|${turnIndex}`)
  if (!list || !list.length) return null
  return list[list.length - 1]
}

/**
 * Resolve ALL captures for an agent across its tool rounds, ordered oldest→newest.
 *
 * An agent's final TEXT output carries no round of its own, but the agent may have
 * run several tool rounds — each `agent.invocation.captured` has a 0-based
 * `turnIndex` (round_num). Used to offer the Inspector with a per-round picker on
 * AssistantMessage, so agents that stream text without any thinking block (e.g.
 * low reasoning_effort) are still inspectable.
 */
export function resolveCapturesForAgent(invocations, agentId) {
  if (!invocations?.byCallId || !agentId) return []
  const list = []
  for (const cap of invocations.byCallId.values()) {
    if (cap.agentId === agentId) list.push(cap)
  }
  list.sort((a, b) => {
    const ta = a.turnIndex ?? -1
    const tb = b.turnIndex ?? -1
    if (ta !== tb) return ta - tb
    return String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
  })
  return list
}

export default useAgentInvocations
