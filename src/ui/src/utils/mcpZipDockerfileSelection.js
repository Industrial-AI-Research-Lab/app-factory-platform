/** Auto-select Dockerfile when analyze returns exactly one usable candidate. */

export function pickAutoDockerfileCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 1) return null
  const only = candidates[0]
  if ((only.preflight_status || 'ready') === 'blocked') return null
  return only
}

export function dockerfileSelectionFromAnalyze(candidates) {
  const picked = pickAutoDockerfileCandidate(candidates)
  if (!picked?.relative_path) {
    return { selectedPath: '', containerPort: null, autoSelected: false }
  }
  const port = picked.suggested_container_port
    ?? (Array.isArray(picked.expose_ports) && picked.expose_ports.length
      ? picked.expose_ports[0]
      : null)
  return {
    selectedPath: picked.relative_path,
    containerPort: port != null && Number(port) > 0 ? Number(port) : null,
    autoSelected: true,
  }
}
