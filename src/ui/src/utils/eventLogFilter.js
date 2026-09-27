/**
 * Event Log vs live streaming: deltas are for SSE/Live Activity only;
 * the Events tab counts and lists logical project events.
 */

const STREAMING_DELTA_TYPES = new Set([
  'agent.streaming.thinking.delta',
  'agent.streaming.text.delta',
  'agent.streaming.tool_call.delta',
])

export function isStreamingDeltaEvent(type) {
  if (!type) return false
  if (STREAMING_DELTA_TYPES.has(type)) return true
  return type.endsWith('.delta')
}

export function filterEventsForDisplay(events) {
  const result = []
  const arr = Array.isArray(events) ? events : []

  for (let i = 0; i < arr.length; i++) {
    const event = arr[i]
    const type = event?.type || ''

    if (isStreamingDeltaEvent(type)) {
      continue
    }

    if (type === 'agent.streaming.thinking.done') {
      result.push({
        type: 'collapsed_thought',
        content: event.data?.content || '',
        thinkingTime: event.data?.thinking_time || 0,
        round: event.data?.round || 1,
        timestamp: event.timestamp,
        originalIndex: i,
      })
      continue
    }

    result.push({ ...event, originalIndex: i })
  }

  return result
}

export function countEventLogDisplay(events) {
  return filterEventsForDisplay(events).length
}

function compareEventsChronological(a, b) {
  const idA = a?.id != null ? String(a.id) : ''
  const idB = b?.id != null ? String(b.id) : ''
  if (idA && idB) {
    if (idA < idB) return -1
    if (idA > idB) return 1
    return 0
  }
  const tA = a?.timestamp instanceof Date ? a.timestamp.getTime() : 0
  const tB = b?.timestamp instanceof Date ? b.timestamp.getTime() : 0
  return tA - tB
}

/** Merge two already-sorted lists in wire order (UUID v7 id). O(n), no localeCompare. */
export function mergeEventsChronological(logicalEvents, streamEvents) {
  const logical = Array.isArray(logicalEvents) ? logicalEvents : []
  const stream = Array.isArray(streamEvents) ? streamEvents : []
  if (!stream.length) return logical
  if (!logical.length) return stream

  const merged = []
  let i = 0
  let j = 0
  while (i < logical.length && j < stream.length) {
    if (compareEventsChronological(logical[i], stream[j]) <= 0) {
      merged.push(logical[i])
      i += 1
    } else {
      merged.push(stream[j])
      j += 1
    }
  }
  while (i < logical.length) {
    merged.push(logical[i])
    i += 1
  }
  while (j < stream.length) {
    merged.push(stream[j])
    j += 1
  }
  return merged
}

/** JSON export for Event Log — logical view only (no delta chunks). */
export function eventsForLogExport(events) {
  const filtered = filterEventsForDisplay(events)
  return filtered.map((item) => {
    if (item.type === 'collapsed_thought') {
      return {
        type: 'agent.streaming.thinking.done',
        content_chars: (item.content || '').length,
        thinking_time: item.thinkingTime,
        round: item.round,
        timestamp: item.timestamp,
      }
    }
    return item
  })
}
