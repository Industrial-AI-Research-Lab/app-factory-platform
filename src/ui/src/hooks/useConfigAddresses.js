import { useEffect, useState } from 'react'
import { apiFetch } from '../utils_api'
import { buildConfigMaps, loadConfigMaps } from '../utils/eventEnrichment'

/**
 * Address maps for the Events tab's Server facet and server:/address: search:
 * MCP tool wire-name -> {server, endpoint} and A2A server_id/name -> {server,
 * endpoint}, joined from the mcp-tools and a2a catalogs (events carry neither).
 * Only non-secret fields are read (name, mcp_server, endpoint, endpoint_url); the
 * config APIs mask secrets anyway. Fault-tolerant: any failure or empty — incl.
 * the A2A list's tenant_admin gate returning 403 for non-admins — yields empty
 * maps, so rows simply render without a server rather than erroring.
 */
export default function useConfigAddresses() {
  const [maps, setMaps] = useState(() => buildConfigMaps([], []))
  useEffect(() => {
    let alive = true
    const getJson = (path) => apiFetch(path)
      .then((res) => (res && res.ok ? res.json() : null))
      .catch(() => null)
    loadConfigMaps(getJson)
      .then((m) => { if (alive) setMaps(m) })
      .catch(() => { if (alive) setMaps(buildConfigMaps([], [])) })
    return () => { alive = false }
  }, [])
  return maps
}
