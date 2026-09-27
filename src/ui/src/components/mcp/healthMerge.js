/** Align with API `_mcp_discover_dedupe_key` when runtime_key is present. */
export function healthRuntimeKey(row) {
  if (row?.runtime_key) return String(row.runtime_key)
  // Fallback for older payloads: host label is weaker than full endpoint but better than server_id alone.
  return [row?.server_id, row?.mode, row?.endpoint_host]
    .map((s) => String(s || '').trim())
    .join('|')
}

const HEALTH_STATUS_RANK = {
  error: 0,
  policy_blocked: 1,
  skipped: 2,
  not_found: 3,
  ok: 4,
}

/** Worst status among all runtime rows for one UI server_id (badge). */
export function aggregateServerHealthRow(healthResult, serverId) {
  if (!healthResult?.servers?.length || serverId === '(no server)') return null
  const rows = healthResult.servers.filter((s) => s?.server_id === serverId)
  if (!rows.length) return null
  return rows.reduce((worst, row) => {
    const wr = HEALTH_STATUS_RANK[worst?.status] ?? 99
    const rr = HEALTH_STATUS_RANK[row?.status] ?? 99
    return rr < wr ? row : worst
  })
}

/**
 * Partial check: replace all runtimes for touched server_ids; keep other servers intact.
 * Key by runtime_key (not bare server_id) so multi-endpoint names do not collapse.
 */
export function mergeHealthResult(prev, data, serverIds) {
  if (!serverIds?.length) return data
  const touched = new Set(serverIds.map((s) => String(s || '').trim()).filter(Boolean))
  const byKey = new Map()
  for (const row of prev?.servers || []) {
    const sid = String(row?.server_id || '').trim()
    if (touched.has(sid)) continue
    const k = healthRuntimeKey(row)
    if (k) byKey.set(k, row)
  }
  for (const row of data?.servers || []) {
    const k = healthRuntimeKey(row)
    if (k) byKey.set(k, row)
  }
  const servers = [...byKey.values()].sort((a, b) => {
    const sid = String(a.server_id).localeCompare(String(b.server_id))
    if (sid !== 0) return sid
    return healthRuntimeKey(a).localeCompare(healthRuntimeKey(b))
  })
  return {
    ...data,
    servers,
    summary_ok: servers.filter((s) => s.status === 'ok').length,
    summary_error: servers.filter((s) => s.status === 'error').length,
    summary_skipped: servers.filter((s) => s.status === 'skipped').length,
    summary_policy_blocked: servers.filter((s) => s.status === 'policy_blocked').length,
    summary_not_found: servers.filter((s) => s.status === 'not_found').length,
  }
}
