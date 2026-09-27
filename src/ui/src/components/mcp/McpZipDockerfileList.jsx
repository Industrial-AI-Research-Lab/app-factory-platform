function mcpScoreLabel(score) {
  const s = Number(score) || 0
  if (s >= 50) return { text: 'High', className: 'text-emerald-300 bg-emerald-950/40 border-emerald-800/50' }
  if (s >= 25) return { text: 'Med', className: 'text-amber-200 bg-amber-950/30 border-amber-800/40' }
  return { text: 'Low', className: 'text-slate-400 bg-slate-800/50 border-slate-600' }
}

function preflightBadge(status) {
  const s = status || 'ready'
  if (s === 'ready') return { text: 'Ready', className: 'text-emerald-300 bg-emerald-950/40 border-emerald-800/50' }
  if (s === 'warnings') return { text: 'Warnings', className: 'text-amber-200 bg-amber-950/30 border-amber-800/40' }
  return { text: 'Blocked', className: 'text-red-300 bg-red-950/40 border-red-800/50' }
}

function DockerfileCandidateCard({ candidate, selected, onSelect }) {
  const badge = mcpScoreLabel(candidate.score)
  const pf = preflightBadge(candidate.preflight_status)
  const issues = candidate.preflight_issues || []

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-3 transition-colors ${
        selected
          ? 'border-purple-500 bg-purple-950/25 ring-1 ring-purple-500/30'
          : 'border-slate-600 bg-slate-750/30 hover:border-slate-500'
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          type="radio"
          readOnly
          checked={selected}
          className="mt-1 accent-purple-500 pointer-events-none"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-slate-200 break-all">{candidate.relative_path}</span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${pf.className}`}>
              {pf.text}
            </span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.className}`}>
              score {candidate.score}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            context <span className="font-mono text-slate-400">{candidate.context_dir || '.'}</span>
            {candidate.expose_ports?.length > 0 && (
              <span>
                {' · '}EXPOSE hint: {candidate.expose_ports.join(', ')}
              </span>
            )}
            {candidate.suggested_mode && (
              <span className="text-slate-600">
                {' · '}ref. mode {candidate.suggested_mode}
              </span>
            )}
          </p>
          {candidate.hints?.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">{candidate.hints.join(' · ')}</p>
          )}
          {issues.length > 0 && (
            <ul className="mt-2 space-y-1">
              {issues.slice(0, 3).map((issue, idx) => (
                <li
                  key={`${issue.code}-${idx}`}
                  className={`text-xs leading-snug ${
                    issue.severity === 'error' ? 'text-red-300/90' : 'text-amber-200/80'
                  }`}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </button>
  )
}

export default function McpZipDockerfileList({ candidates, selectedPath, onSelect }) {
  if (!candidates?.length) {
    return (
      <p className="text-xs text-slate-500 py-2">
        No Dockerfile found yet. Upload a ZIP or run analysis again.
      </p>
    )
  }

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {candidates.map(c => (
        <DockerfileCandidateCard
          key={c.relative_path}
          candidate={c}
          selected={selectedPath === c.relative_path}
          onSelect={() => onSelect(c.relative_path)}
        />
      ))}
    </div>
  )
}
