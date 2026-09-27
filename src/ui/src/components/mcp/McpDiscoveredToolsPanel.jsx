import { entityShortDescription } from '../../utils/entity_descriptions'

export default function McpDiscoveredToolsPanel({
  discoveredTools,
  selectedDiscovered,
  onToggleAllDiscovered,
  onDiscoveredCheckChange,
  onImport,
  importSaving,
  discovering,
}) {
  if (!discovering && (!discoveredTools || discoveredTools.length === 0)) {
    return null
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onImport}
          disabled={importSaving || discovering || !discoveredTools?.length}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
        >
          {importSaving ? 'Importing...' : 'Import Selected'}
        </button>
        {discovering && (
          <span className="text-xs text-slate-400">Discovering tools…</span>
        )}
      </div>

      {discoveredTools?.length > 0 && (
        <div className="border border-slate-700 rounded">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="px-3 py-2 text-left">
                  <button
                    type="button"
                    onClick={onToggleAllDiscovered}
                    className="underline-offset-2 hover:underline"
                    title="Click to select or deselect all"
                  >
                    Use
                  </button>
                </th>
                <th className="px-3 py-2 text-left">Tool</th>
                <th className="px-3 py-2 text-left">Description</th>
              </tr>
            </thead>
            <tbody>
              {discoveredTools.map((t, idx) => (
                <tr key={t.name} className="border-b border-slate-700/50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={!!selectedDiscovered[t.name]}
                      onChange={e => onDiscoveredCheckChange(idx, e.target.checked, e.nativeEvent.shiftKey)}
                      className="accent-blue-500"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">{t.name}</td>
                  <td className="px-3 py-2 text-slate-400">{entityShortDescription(t) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
