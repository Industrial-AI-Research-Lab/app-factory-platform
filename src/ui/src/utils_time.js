/**
 * Time / timestamp helpers.
 *
 * The backend historically emits ISO timestamps via `datetime.utcnow().isoformat()`
 * which produces naive strings like "2026-05-06T14:38:05.123456" — no `Z` and
 * no offset. JS's `new Date(naive_iso)` interprets those as LOCAL time, which
 * silently shifts every UTC-stored timestamp by the viewer's offset, breaking
 * chronological ordering and time-of-day display.
 *
 * `parseTimestamp` treats any ISO string lacking explicit TZ info as UTC, so
 * already-stored documents render correctly without backfilling. New writes
 * should use TZ-aware strings (`datetime.now(timezone.utc).isoformat()`); this
 * helper is the safety net.
 */

/**
 * Parse a timestamp into a Date. Accepts:
 *  - Date instances (returned unchanged)
 *  - numbers (treated as ms since epoch by Date)
 *  - strings: ISO with TZ → parsed as-is; ISO without TZ → assumed UTC
 *
 * Returns null for falsy / unparseable inputs.
 */
export function parseTimestamp(value) {
  if (value == null) return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof value !== 'string') return null

  let s = value.trim()
  if (!s) return null

  // ISO date-time strings start with YYYY-MM-DD or YYYY-MM-DDTHH:MM.
  // Detect explicit TZ info: trailing `Z` or `[+-]HH:MM` after the time portion.
  const looksISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(s)
  if (looksISO) {
    const timePart = s.split('T')[1] || ''
    const hasTZ = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(timePart)
    if (!hasTZ) {
      // Assume UTC. Use space->T normalization defensively.
      s = s.replace(' ', 'T') + 'Z'
    }
  }

  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** Convenience: parse + return ms since epoch (0 if unparseable, for sort fallbacks). */
export function timestampMs(value) {
  const d = parseTimestamp(value)
  return d ? d.getTime() : 0
}
