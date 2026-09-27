import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { formatHealthCheckTime, healthStatusColor, healthStatusLabel } from './helpers'

export default function McpHealthCheckPanel({
  dismissed,
  loading,
  error,
  result,
  collapsed,
  onToggleCollapsed,
  onDismiss,
}) {
  if (dismissed || loading || (!error && !result)) return null

  return (
    <div className={`rounded-lg mb-4 overflow-hidden border ${
      error ? 'bg-red-900/30 border-red-800' : 'bg-slate-800/80 border-slate-600'
    }`}>
      <div className={`px-4 py-2 text-xs flex items-start gap-2 border-b ${
        error ? 'border-red-800/80 text-red-200' : 'border-slate-700 text-slate-400'
      }`}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex flex-wrap gap-3 flex-1 min-w-0 text-left hover:opacity-90"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="font-medium text-slate-200">MCP Health Check</span>
          {result?.checked_at && (
            <span>
              Checked:{' '}
              <span className={error ? 'text-red-100' : 'text-slate-200'}>
                {formatHealthCheckTime(result.checked_at)}
              </span>
            </span>
          )}
          {result && !error && (
            <>
              <span className="text-green-400">ok: {result.summary_ok ?? 0}</span>
              <span className="text-red-400">error: {result.summary_error ?? 0}</span>
              <span className="text-amber-300">skipped: {result.summary_skipped ?? 0}</span>
              <span className="text-amber-300">allowlist: {result.summary_policy_blocked ?? 0}</span>
              <span className="text-slate-400">not found: {result.summary_not_found ?? 0}</span>
            </>
          )}
          {error && (
            <span className="text-red-300 truncate max-w-full">Failed: {error}</span>
          )}
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700/80"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700/80"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto">
          {error && <p className="px-4 py-3 text-sm text-red-200">{error}</p>}
          {result?.servers?.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-700 text-left">
                  <th className="px-4 py-2">Server</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Host / mode</th>
                  <th className="px-4 py-2">Tools</th>
                  <th className="px-4 py-2">ms</th>
                  <th className="px-4 py-2">Message</th>
                </tr>
              </thead>
              <tbody>
                {result.servers.map((row, i) => {
                  const st = row.status
                  return (
                    <tr key={`${row.server_id}-${i}`} className="border-b border-slate-700/50">
                      <td className="px-4 py-2 font-mono text-slate-200">{row.server_id}</td>
                      <td className={`px-4 py-2 ${healthStatusColor(st)}`}>{healthStatusLabel(st)}</td>
                      <td className="px-4 py-2 text-slate-400 max-w-[200px] truncate" title={`${row.mode} ${row.endpoint_host || ''}`}>
                        {row.mode} · {row.endpoint_host || '—'}
                      </td>
                      <td className="px-4 py-2 text-slate-300">{row.tools_count != null ? row.tools_count : '—'}</td>
                      <td className="px-4 py-2 text-slate-400">{row.duration_ms != null ? row.duration_ms : '—'}</td>
                      <td className="px-4 py-2 text-slate-400 max-w-lg whitespace-pre-wrap break-words">{row.message || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {result && (!result.servers || result.servers.length === 0) && !error && (
            <p className="px-4 py-3 text-sm text-slate-500">
              No MCP servers found in saved tools (entries with source=mcp_server required).
            </p>
          )}
        </div>
      )}
    </div>
  )
}
