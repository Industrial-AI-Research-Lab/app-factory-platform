export default function McpTenantJsonPanel({
  embedded = false,
  expanded,
  onToggleExpanded,
  raw,
  onRawChange,
  onSave,
  saving,
  error,
  warnings = [],
  savePreview,
  saveDiff,
}) {
  const isOpen = embedded || expanded
  const preview = savePreview?.preview
  const previewError = savePreview?.error

  return (
    <div className="mb-6 bg-slate-800 border border-slate-700 rounded-lg">
      {embedded ? (
        <div className="px-4 py-3 border-b border-slate-700">
          <span className="text-sm font-semibold">Tenant mcp.json (saved for this AppFactory tenant)</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-750"
        >
          <span className="text-sm font-semibold">Tenant mcp.json (saved for this AppFactory tenant)</span>
          <span className="text-xs text-slate-400">{expanded ? 'Hide' : 'Show'}</span>
        </button>
      )}
      {isOpen && (
        <div className={`px-4 pb-4 ${embedded ? '' : 'border-t border-slate-700'}`}>
          <div className="mt-3 p-3 rounded border border-slate-600 bg-slate-750/50 space-y-2">
            <p className="text-xs text-slate-500">
              Bulk sync: <strong className="text-slate-300">new</strong> server blocks trigger discover/import only for
              those servers. Existing servers are not rediscovered. Tool names must use a-z, A-Z, 0-9, _, - (invalid
              names are auto-fixed on save).
            </p>
            {preview && !previewError && (
              <div className="text-xs text-slate-400 bg-slate-900/50 border border-slate-600 rounded px-2 py-2 space-y-1">
                <div className="font-medium text-slate-300">Preview before save</div>
                {preview.added_servers?.length > 0 && (
                  <div>Import (discover): {preview.added_servers.join(', ')}</div>
                )}
                {preview.removed_servers?.length > 0 && (
                  <div className="text-red-300">Remove servers: {preview.removed_servers.join(', ')}</div>
                )}
                {preview.unchanged_servers?.length > 0 && (
                  <div>No rediscovery: {preview.unchanged_servers.join(', ')}</div>
                )}
                {preview.servers_tool_list_changed?.length > 0 && (
                  <div>Apply tools/disabledTools: {preview.servers_tool_list_changed.join(', ')}</div>
                )}
                {saveDiff?.servers_missing_tools?.length > 0 && (
                  <div>Imported (DB was empty): {saveDiff.servers_missing_tools.join(', ')}</div>
                )}
                {!preview.added_servers?.length && !preview.removed_servers?.length
                  && !preview.servers_tool_list_changed?.length && (
                  <div>No structural changes detected.</div>
                )}
              </div>
            )}
            {previewError && (
              <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/50 rounded px-2 py-1.5">
                Cannot preview: {previewError}
              </div>
            )}
            <textarea
              value={raw}
              onChange={e => onRawChange(e.target.value)}
              placeholder='{ "mcpServers": { "docling-adapter-mcp": { "url": "https://..." } } }'
              rows={15}
              className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onSave}
                disabled={saving || !!previewError}
                className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save tenant JSON'}
              </button>
            </div>
            {warnings.length > 0 && (
              <ul className="text-xs text-amber-200 bg-amber-900/20 border border-amber-800/50 rounded px-2 py-1.5 list-disc pl-4 space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {error && (
              <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded px-2 py-1.5">{error}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
