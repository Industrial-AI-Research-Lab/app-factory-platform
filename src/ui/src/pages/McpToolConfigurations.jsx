import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, Archive, Plus, RefreshCw, Search, Table2 } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import TabNavigation from '../components/TabNavigation'
import McpConfigureGuide from '../components/mcp/McpConfigureGuide'
import McpDiscoveryPanel from '../components/mcp/McpDiscoveryPanel'
import McpHealthCheckPanel from '../components/mcp/McpHealthCheckPanel'
import McpTenantJsonPanel from '../components/mcp/McpTenantJsonPanel'
import McpToolFormModal from '../components/mcp/McpToolFormModal'
import McpServerSettingsModal from '../components/mcp/McpServerSettingsModal'
import McpToolsByServer from '../components/mcp/McpToolsByServer'
import McpZipImportPanel from '../components/mcp/McpZipImportPanel'
import useMcpToolsPage from '../hooks/useMcpToolsPage'
import useMcpZipBuild from '../hooks/useMcpZipBuild'
import { notify } from '../utils_notify'

const TAB_INSTALLED = 0
const TAB_CONFIGURE = 1
const TAB_ZIP = 2

export default function McpToolConfigurations() {
  const [activeTab, setActiveTab] = useState(TAB_INSTALLED)
  const [selectedServers, setSelectedServers] = useState({})

  const p = useMcpToolsPage()
  const [searchParams] = useSearchParams()

  // Deep link from the Events-tab cog (?server=<mcp_server>): the tool filter
  // already matches on mcp_server, so narrowing to it surfaces just that server.
  useEffect(() => {
    const server = searchParams.get('server')
    if (server) p.setFilter(server)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const h = p.health
  const c = p.cursorJson
  const d = p.discover
  const selectedGroupKeys = Object.keys(selectedServers).filter((id) => selectedServers[id])
  const selectedGroups = p.groupedByServer
    .filter((group) => selectedServers[group.groupKey])
  const selectedIds = selectedGroups.map((group) => group.serverId)
  const selectedTenantIds = [...new Set(selectedGroups.map((group) => group.tenantId))]
  const selectedTenantId = selectedTenantIds.length === 1 ? selectedTenantIds[0] : null
  const toggleServerSelected = (serverId) => {
    setSelectedServers((prev) => {
      const next = { ...prev }
      if (next[serverId]) delete next[serverId]
      else next[serverId] = true
      return next
    })
  }
  const zip = useMcpZipBuild({
    onWizardReset: () => d.resetZipDiscoverSession(),
    onSyncDiscoverFromZip: (payload, imageTag) => d.applyZipPackageToDiscoverForm(payload, imageTag),
  })

  const continueZipToDiscover = (payload, imageTag) => {
    if (!payload) return
    d.discoverAfterZipImport(payload, imageTag)
  }

  const openEditOnConfigureTab = (tool) => {
    setActiveTab(TAB_CONFIGURE)
    p.openEdit(tool)
  }

  const discoveryPanelProps = {
    embedded: true,
    expanded: true,
    discoverForm: d.discoverForm,
    setDiscoverForm: d.setDiscoverForm,
    discoveryConnectMode: d.discoveryConnectMode,
    setDiscoveryConnectMode: d.setDiscoveryConnectMode,
    discoverServerIdHasSpaces: d.discoverServerIdHasSpaces,
    mcpParseRaw: d.mcpParseRaw,
    setMcpParseRaw: d.setMcpParseRaw,
    mcpPresetNpxDockerImage: d.mcpPresetNpxDockerImage,
    setMcpPresetNpxDockerImage: d.setMcpPresetNpxDockerImage,
    mcpPresetError: c.error,
    setMcpPresetError: c.setError,
    mcpPresetWarnings: d.mcpPresetWarnings,
    mcpPresetEntries: d.mcpPresetEntries,
    mcpPresetSelectedKey: d.mcpPresetSelectedKey,
    onParseCursorPresetJson: d.parseCursorPresetJson,
    onMcpPresetServerChange: d.onMcpPresetServerChange,
    discovering: d.discovering,
    onDiscover: d.discoverExternalTools,
    onImport: d.importDiscoveredTools,
    importSaving: d.importSaving,
    discoveredTools: d.discoveredTools,
    selectedDiscovered: d.selectedDiscovered,
    onToggleAllDiscovered: d.toggleAllDiscovered,
    onDiscoveredCheckChange: d.onDiscoveredCheckChange,
  }

  const tabs = [
    {
      label: 'Installed tools',
      icon: <Table2 className="w-4 h-4" />,
      badge: p.tools.length > 0 ? String(p.tools.length) : null,
      content: (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative w-48 max-w-full">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={p.filter}
                onChange={e => p.setFilter(e.target.value)}
                placeholder="Filter tools..."
                className="w-full bg-slate-700 border border-slate-600 rounded pl-8 pr-2 py-1.5 text-xs"
              />
            </div>
            <button
              type="button"
              onClick={() => setActiveTab(TAB_CONFIGURE)}
              className="px-3 py-1.5 text-xs bg-blue-800 hover:bg-blue-700 rounded flex items-center gap-1 border border-blue-600/60"
            >
              <Plus className="w-3.5 h-3.5" /> Add MCP server
            </button>
            <button
              type="button"
              onClick={() => h.runHealthCheck()}
              disabled={h.loading}
              className="px-3 py-1.5 text-xs bg-purple-800 hover:bg-purple-700 rounded flex items-center gap-1 border border-purple-600/60"
              title="Health check for all saved MCP servers (list_tools)"
            >
              <Activity className={`w-3.5 h-3.5 ${h.loading ? 'animate-pulse' : ''}`} />
              {h.loading ? 'Checking…' : 'Health Check'}
            </button>
            <button
              type="button"
              onClick={() => h.runHealthCheck({ serverIds: selectedIds, tenantId: selectedTenantId })}
              disabled={h.loading || selectedGroupKeys.length === 0 || selectedTenantIds.length !== 1}
              className="px-3 py-1.5 text-xs bg-purple-900/80 hover:bg-purple-800 rounded flex items-center gap-1 border border-purple-700/50 disabled:opacity-40"
              title="Health check selected MCP servers from one tenant"
            >
              <Activity className="w-3.5 h-3.5" />
              Check selected ({selectedGroupKeys.length})
            </button>
            <button
              type="button"
              onClick={p.fetchAll}
              className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          </div>

          <McpHealthCheckPanel
            dismissed={h.panelDismissed}
            loading={h.loading}
            error={h.error}
            result={h.result}
            collapsed={h.panelCollapsed}
            onToggleCollapsed={() => h.setPanelCollapsed(v => !v)}
            onDismiss={h.dismissPanel}
          />

          {p.loading && <div className="text-slate-400 text-sm my-4">Loading...</div>}

          <McpToolsByServer
            groups={p.groupedByServer}
            loading={p.loading}
            saving={p.saving}
            healthResult={h.result}
            healthLoading={h.loading}
            selectedServerIds={selectedServers}
            onToggleServerSelected={toggleServerSelected}
            onHealthCheckServer={(group) => h.runHealthCheck({
              serverIds: [group.serverId],
              tenantId: group.tenantId,
            })}
            onToggleEnabled={p.toggleEnabled}
            onEdit={openEditOnConfigureTab}
            onDelete={p.deleteTool}
            onRestartServer={p.restartServer}
            onDeleteServer={p.deleteServer}
            onServerSettings={p.openServerSettings}
            isRoot={p.isRoot}
          />
        </>
      ),
    },
    {
      label: 'Add & Configure',
      icon: <Plus className="w-4 h-4" />,
      content: (
        <>
          <McpConfigureGuide />
          <McpDiscoveryPanel {...discoveryPanelProps} />
          <McpTenantJsonPanel
            embedded
            expanded
            raw={c.raw}
            onRawChange={(v) => { c.setRaw(v); c.setError(null) }}
            onSave={c.saveFromEditor}
            saving={c.saving}
            error={c.error}
            warnings={c.warnings}
            savePreview={c.savePreview}
            saveDiff={c.saveDiff}
          />
        </>
      ),
    },
    {
      label: 'Import from ZIP',
      icon: <Archive className="w-4 h-4" />,
      badge: zip.builtImages.length > 0 ? String(zip.builtImages.length) : null,
      content: (
        <McpZipImportPanel
          zip={zip}
          discover={d}
          onContinueFromZip={continueZipToDiscover}
        />
      ),
    },
  ]

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">MCP Tools</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold mb-4">MCP Tools</h1>

        {p.error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">{p.error}</div>
        )}

        <TabNavigation
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
      </main>

      <McpToolFormModal
        open={!!p.editingId}
        editingId={p.editingId}
        form={p.form}
        setForm={p.setForm}
        modalError={p.modalError}
        formIdHasSpaces={p.formIdHasSpaces}
        saving={p.saving.modal}
        onClose={p.closeModal}
        onSave={p.saveTool}
        onClearModalError={p.clearModalError}
      />

      {p.serverSettingsGroup && p.serverSettingsForm && (
        <McpServerSettingsModal
          serverId={p.serverSettingsGroup.serverId}
          tenantId={p.serverSettingsGroup.tenantId}
          isRoot={p.isRoot}
          form={p.serverSettingsForm}
          setForm={p.setServerSettingsForm}
          error={p.serverSettingsError}
          saving={Boolean(p.saving[`server:${p.serverSettingsGroup.groupKey}`])}
          onClose={p.closeServerSettings}
          onSave={p.saveServerConnection}
        />
      )}
    </div>
  )
}
