import { DEFAULT_MCP_NPX_DOCKER_IMAGE } from '../../utils/mcp_cursor_preset'
import { entityShortDescription } from '../../utils/entity_descriptions'
import HeadersEditor from './HeadersEditor'

export default function McpDiscoveryPanel({
  embedded = false,
  expanded,
  onToggleExpanded,
  discoverForm,
  setDiscoverForm,
  discoveryConnectMode,
  setDiscoveryConnectMode,
  discoverServerIdHasSpaces,
  mcpParseRaw,
  setMcpParseRaw,
  mcpPresetNpxDockerImage,
  setMcpPresetNpxDockerImage,
  mcpPresetError,
  setMcpPresetError,
  mcpPresetWarnings,
  mcpPresetEntries,
  mcpPresetSelectedKey,
  onParseCursorPresetJson,
  onMcpPresetServerChange,
  discovering,
  onDiscover,
  onImport,
  importSaving,
  discoveredTools,
  selectedDiscovered,
  onToggleAllDiscovered,
  onDiscoveredCheckChange,
}) {
  const isOpen = embedded || expanded

  return (
    <div className="mb-6 bg-slate-800 border border-slate-700 rounded-lg">
      {embedded ? (
        <div className="px-4 py-3 border-b border-slate-700">
          <span className="text-sm font-semibold">External MCP Server Discovery</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-750"
        >
          <span className="text-sm font-semibold">External MCP Server Discovery</span>
          <span className="text-xs text-slate-400">{expanded ? 'Hide' : 'Show'}</span>
        </button>
      )}

      {isOpen && (
        <div className={`px-4 pb-4 ${embedded ? '' : 'border-t border-slate-700'}`}>
          <div className="mt-3 p-3 rounded border border-slate-600 bg-slate-750/50 space-y-2">
            <div className="text-xs text-slate-400 font-medium">Paste from local Cursor file (fills form only)</div>
            <p className="text-xs text-slate-500">
              This box does <strong className="text-slate-300">not</strong> save tenant mcp.json — it only fills the discovery form below.
              Paste JSON with an <code className="text-slate-400">mcpServers</code> key. Fields{' '}
              <code className="text-slate-400">url</code>,{' '}
              <code className="text-slate-400">command</code>+<code className="text-slate-400">args</code>,{' '}
              <code className="text-slate-400">image</code>+<code className="text-slate-400">args</code>,{' '}
              <code className="text-slate-400">env</code>,{' '}
              <code className="text-slate-400">headers</code>,{' '}
              <code className="text-slate-400">timeout</code> (ms) are mapped into the form below.
              Optional <code className="text-slate-400">transport</code>:{' '}
              <code className="text-slate-400">http</code> or{' '}
              <code className="text-slate-400">streamable-http</code> for URLs.
              Entries with <code className="text-slate-400">command: npx</code> default to a Node Docker image (below) so discovery works without Node on the API host.
            </p>
            <div className="flex flex-col gap-2 text-xs text-slate-400 border border-slate-600 rounded px-2 py-2 bg-slate-900/40">
              <label className="flex flex-col gap-1">
                <span className="text-slate-500">Docker image tag for npx-runner</span>
                <input
                  type="text"
                  value={mcpPresetNpxDockerImage}
                  onChange={e => setMcpPresetNpxDockerImage(e.target.value)}
                  placeholder={DEFAULT_MCP_NPX_DOCKER_IMAGE}
                  className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-200 font-mono"
                />
              </label>
            </div>
            <div className="text-xs text-slate-400 font-medium mt-1">JSON to parse and fill the form</div>
            <textarea
              value={mcpParseRaw}
              onChange={e => { setMcpParseRaw(e.target.value); setMcpPresetError(null) }}
              placeholder="Full mcp.json, mcpServers block, or individual server entries"
              rows={15}
              className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
            />
            {mcpPresetError && (
              <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded px-2 py-1.5">{mcpPresetError}</div>
            )}
            {mcpPresetWarnings.length > 0 && (
              <ul className="text-xs text-amber-200/90 list-disc pl-4 space-y-0.5">
                {mcpPresetWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <button
                type="button"
                onClick={onParseCursorPresetJson}
                className="px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 rounded"
              >
                Parse and fill form
              </button>
              {mcpPresetEntries && mcpPresetEntries.length > 1 && (
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  <span>Server</span>
                  <select
                    value={mcpPresetSelectedKey}
                    onChange={e => onMcpPresetServerChange(e.target.value)}
                    className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-200"
                  >
                    {mcpPresetEntries.map(([k]) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setDiscoveryConnectMode('remote')}
              className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                discoveryConnectMode === 'remote'
                  ? 'bg-purple-600 border-purple-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-500'
              }`}
            >
              Remote MCP
            </button>
            <button
              type="button"
              onClick={() => setDiscoveryConnectMode('docker')}
              className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                discoveryConnectMode === 'docker'
                  ? 'bg-purple-600 border-purple-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-500'
              }`}
            >
              Docker
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <label className="block">
              <span className="text-xs text-slate-400">Server ID</span>
              <input
                type="text"
                value={discoverForm.server_id}
                onChange={e => setDiscoverForm(f => ({ ...f, server_id: e.target.value }))}
                placeholder="my-server"
                className={`w-full bg-slate-700 border rounded px-2 py-1.5 text-sm mt-1 ${
                  discoverServerIdHasSpaces ? 'border-red-500' : 'border-slate-600'
                }`}
              />
              {discoverServerIdHasSpaces && (
                <p className="mt-1 text-xs text-red-300">Server ID cannot contain spaces. Use &quot;-&quot; or &quot;_&quot;.</p>
              )}
            </label>
            <label className="block md:col-span-2">
              <span className="text-xs text-slate-400">Connection Type</span>
              <div className="flex gap-2 mt-1">
                {(discoveryConnectMode === 'docker'
                  ? ['http', 'streamable-http', 'stdio']
                  : ['http', 'streamable-http']).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDiscoverForm(f => ({ ...f, mode: m }))}
                    className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                      discoverForm.mode === m
                        ? 'bg-purple-600 border-purple-500 text-white'
                        : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    {m === 'http' ? 'HTTP (JSON-RPC)' : m === 'streamable-http' ? 'HTTP Streamable' : 'STDIO'}
                  </button>
                ))}
              </div>
            </label>

            {discoveryConnectMode === 'docker' && (
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-xs text-slate-400">Scope (Docker import)</span>
                  <select
                    value={discoverForm.mcp_runtime_scope}
                    onChange={e => setDiscoverForm(f => ({ ...f, mcp_runtime_scope: e.target.value }))}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                  >
                    <option value="project">Project</option>
                    <option value="tenant">Tenant</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">Container idle timeout (sec)</span>
                  <input
                    type="text"
                    value={discoverForm.mcp_idle_timeout}
                    onChange={e => setDiscoverForm(f => ({ ...f, mcp_idle_timeout: e.target.value }))}
                    placeholder="empty, -1"
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">On project complete</span>
                  <select
                    value={discoverForm.mcp_on_project_complete}
                    onChange={e => setDiscoverForm(f => ({ ...f, mcp_on_project_complete: e.target.value }))}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                  >
                    <option value="remove">Remove</option>
                    <option value="stop_only">Stop only</option>
                  </select>
                </label>
              </div>
            )}

            {(discoverForm.mode === 'http' || discoverForm.mode === 'streamable-http') && (
              <>
                <label className="block md:col-span-3">
                  <span className="text-xs text-slate-400">Connection URL</span>
                  <input
                    type="text"
                    value={discoverForm.endpoint}
                    onChange={e => setDiscoverForm(f => ({ ...f, endpoint: e.target.value }))}
                    placeholder={
                      discoveryConnectMode === 'docker'
                        ? 'Not required for Docker runtime (endpoint is built automatically)'
                        : (discoverForm.mode === 'streamable-http'
                          ? 'https://api.example.com/mcp'
                          : 'http://mcp-server:8080/mcp')
                    }
                    disabled={discoveryConnectMode === 'docker'}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                  />
                </label>
                <div className="md:col-span-3">
                  <span className="text-xs text-slate-400 block mb-1.5">Headers</span>
                  <HeadersEditor
                    headers={discoverForm.headers}
                    onChange={h => setDiscoverForm(f => ({ ...f, headers: h }))}
                  />
                </div>
              </>
            )}

            {discoverForm.mode === 'stdio' && (
              <div className="md:col-span-3">
                <p className="text-xs text-slate-500 mb-2">Docker image or local command</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-slate-400">Docker Image</span>
                    <input
                      type="text"
                      value={discoverForm.image}
                      onChange={e => setDiscoverForm(f => ({ ...f, image: e.target.value }))}
                      placeholder="mcp/context7"
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-slate-400">Container env vars (KEY=VALUE, ...)</span>
                    <input
                      type="text"
                      value={discoverForm.docker_env_vars_raw}
                      onChange={e => setDiscoverForm(f => ({ ...f, docker_env_vars_raw: e.target.value }))}
                      placeholder="MCP_TRANSPORT=stdio, API_KEY=xxx"
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-xs text-slate-400">Container args (space-separated)</span>
                    <input
                      type="text"
                      value={discoverForm.docker_cmd_args_raw}
                      onChange={e => setDiscoverForm(f => ({ ...f, docker_cmd_args_raw: e.target.value }))}
                      placeholder="/workspace"
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                    />
                  </label>
                </div>
              </div>
            )}

            <label className="block">
              <span className="text-xs text-slate-400">Timeout (sec)</span>
              <input
                type="number"
                value={discoverForm.timeout_seconds}
                onChange={e => setDiscoverForm(f => ({ ...f, timeout_seconds: Number(e.target.value) || 30 }))}
                min={1}
                max={300}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={onDiscover}
              disabled={discovering || discoverServerIdHasSpaces}
              className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 rounded disabled:opacity-50"
            >
              {discovering ? 'Discovering...' : 'Discover Tools'}
            </button>
            <button
              type="button"
              onClick={onImport}
              disabled={importSaving || discoveredTools.length === 0}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
            >
              {importSaving ? 'Importing...' : 'Import Selected'}
            </button>
          </div>

          {discoveredTools.length > 0 && (
            <div className="mt-3 border border-slate-700 rounded">
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
      )}
    </div>
  )
}
