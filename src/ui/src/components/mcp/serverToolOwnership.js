// Self-contained (no imports) so it is unit-testable under `node --test`.

/**
 * Split a server group's tools into the tenant's own (deletable) and shared
 * platform (__system__) tools. A tenant cannot delete a __system__ tool — the
 * backend answers 403 — so a bulk "delete server" must never attempt it: after
 * a fork+catch-up or a rename-away the group is mixed, and deleting straight
 * through would 403 partway, after already destroying the owned forks it did
 * reach (customizations lost). The frontend deletes only what it owns.
 */
export function partitionServerToolsForDelete(serverTools) {
  const owned = []
  const shared = []
  for (const t of serverTools || []) {
    if (String(t?.tenant_id || '') === '__system__') shared.push(t)
    else owned.push(t)
  }
  return { owned, shared }
}
