/**
 * Fetch-based SSE client — replaces native EventSource to support
 * Authorization headers (Bearer token).
 *
 * Native EventSource cannot send custom headers, which breaks
 * authenticated SSE endpoints.
 *
 * Usage:
 *   const sse = createFetchEventSource(url, {
 *     headers: { Authorization: `Bearer ${token}` },
 *     onEvent: (eventType, data, lastEventId) => { ... },
 *     onError: (err) => { ... },
 *     onOpen: () => { ... },
 *   })
 *   // later:
 *   sse.close()
 */

const SSE_RECONNECT_MS = 3000

/**
 * Parse a raw SSE chunk into individual events.
 * SSE spec: fields separated by newlines, events separated by blank lines.
 */
function parseSSE(raw) {
  const events = []
  const blocks = raw.split(/\n\n+/)
  for (const block of blocks) {
    if (!block.trim()) continue
    let eventType = 'message'
    let data = ''
    let id = null
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim()
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim()
      }
    }
    if (data || eventType !== 'message') {
      events.push({ type: eventType, data, id })
    }
  }
  return events
}

export function createFetchEventSource(url, {
  headers = {},
  onEvent,
  onError,
  onOpen,
} = {}) {
  let abortController = new AbortController()
  let closed = false
  let lastEventId = null

  async function connect() {
    if (closed) return

    const reqHeaders = { ...headers, Accept: 'text/event-stream' }
    if (lastEventId) {
      reqHeaders['Last-Event-ID'] = lastEventId
    }

    try {
      const response = await fetch(url, {
        signal: abortController.signal,
        headers: reqHeaders,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const err = new Error(`SSE ${response.status}: ${body}`)
        err.status = response.status
        if (onError) onError(err)
        // Don't reconnect on auth errors
        if (response.status === 401 || response.status === 403) return
        scheduleReconnect()
        return
      }

      if (onOpen) onOpen()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete events (separated by double newlines)
        const lastDoubleNewline = buffer.lastIndexOf('\n\n')
        if (lastDoubleNewline === -1) continue

        const complete = buffer.slice(0, lastDoubleNewline + 2)
        buffer = buffer.slice(lastDoubleNewline + 2)

        const events = parseSSE(complete)
        for (const event of events) {
          if (event.id) lastEventId = event.id
          if (onEvent) onEvent(event.type, event.data, event.id)
        }
      }

      // Stream ended normally — reconnect unless closed
      if (!closed) scheduleReconnect()
    } catch (err) {
      if (err.name === 'AbortError' || closed) return
      if (onError) onError(err)
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (closed) return
    setTimeout(() => connect(), SSE_RECONNECT_MS)
  }

  // Start
  connect()

  return {
    close() {
      closed = true
      abortController.abort()
    },
  }
}
