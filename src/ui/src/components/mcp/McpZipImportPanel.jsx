import McpBuiltImagesPanel from './McpBuiltImagesPanel'
import McpDiscoveredToolsPanel from './McpDiscoveredToolsPanel'
import McpZipBuildConsole from './McpZipBuildConsole'
import McpZipDockerfileList from './McpZipDockerfileList'
import McpZipDropzone from './McpZipDropzone'
import McpZipWizardStepper from './McpZipWizardStepper'

export default function McpZipImportPanel({ zip, discover, onContinueFromZip }) {
  const imageTag = zip.buildStatus?.image_tag || zip.previewImageTag
  const buildDone = zip.buildStatus?.status === 'ready'
  const isReady = buildDone
  const buildInFlight = zip.busy
    || zip.buildStatus?.status === 'building'
    || zip.buildStatus?.status === 'image_ready'
    || zip.buildStatus?.status === 'smoke_running'
  const isBuilding = buildInFlight
  const buildBlocked = zip.isCandidateBuildBlocked?.() ?? false
  const canUpload = Boolean(zip.serverId?.trim() && zip.zipFile) && !zip.busy && !zip.uploading
  const canAnalyze = Boolean(zip.uploadId && zip.serverId?.trim()) && !zip.busy && !zip.uploading
  const canBuild = Boolean(zip.formReady && zip.uploadId) && !buildInFlight && !zip.uploading && !buildBlocked
  const httpMode = zip.mode === 'streamable-http'
  const showLog = zip.buildLog || isBuilding || zip.buildStatus?.status === 'build_failed'
    || zip.buildStatus?.status === 'smoke_failed'
  const buildFailed = zip.buildStatus?.status === 'build_failed' || zip.buildStatus?.status === 'smoke_failed'
  const showWizard = zip.wizardStep >= 2 || zip.uploadId || zip.zipFile
  const serverIdLocked = Boolean(zip.uploadId)

  const handleContinue = () => {
    const payload = zip.getConnectPayload()
    onContinueFromZip?.(payload, imageTag)
  }

  const showDiscovered =
    discover?.discovering
    || (discover?.discoveredTools?.length > 0)

  return (
    <div className="space-y-4 mb-6">
      <div className="bg-slate-800 border border-slate-700 rounded-lg">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
          <div>
            <span className="text-sm font-semibold">Import MCP from ZIP</span>
            <p className="text-xs text-slate-500 mt-0.5">
              Tenant admin only. Server ID from ZIP name; pick Dockerfile, mode (stdio or HTTP), then build.
            </p>
          </div>
          <button
            type="button"
            onClick={zip.resetWizard}
            className="text-xs text-slate-400 hover:text-slate-200 shrink-0"
          >
            Reset
          </button>
        </div>

        <div className="px-4 pb-4 pt-3">
          <section className="p-3 rounded border border-slate-600 bg-slate-750/50 space-y-3">
            <label className="block">
              <span className="text-xs text-slate-400">Server ID (required)</span>
              <input
                type="text"
                value={zip.serverId}
                onChange={e => zip.setServerId(e.target.value)}
                placeholder="mcp-time"
                disabled={zip.uploading || isBuilding || serverIdLocked}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1 font-mono disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {serverIdLocked
                  ? 'Locked after upload so analyze/build stay tied to the same package.'
                  : 'From ZIP name with -zip suffix (e.g. context7-zip); edit before upload if needed.'}
              </p>
            </label>
            <div className="text-xs text-slate-400 font-medium">ZIP archive</div>
            <McpZipDropzone zip={zip} />
            {(zip.statusHint || (zip.zipFile && !zip.uploadId && !zip.busy)) && (
              <p className="text-xs text-purple-200/90 bg-purple-950/30 border border-purple-800/40 rounded px-2 py-1.5">
                {zip.statusHint || 'ZIP selected — waiting for upload…'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canUpload}
                onClick={() => zip.uploadZip(null, { autoScan: true })}
                className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40"
              >
                Upload and scan
              </button>
              <button
                type="button"
                disabled={!canAnalyze}
                onClick={zip.discoverDockerfile}
                className="text-xs px-3 py-1.5 rounded border border-slate-500 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              >
                Scan Dockerfiles
              </button>
            </div>
          </section>

          {showWizard && (
            <>
              <div className="mt-4">
                <McpZipWizardStepper currentStep={zip.wizardStep} />
              </div>

              <div className="h-1.5 w-full bg-slate-700 rounded-full overflow-hidden my-4">
                <div
                  className={`h-full transition-all duration-500 ${
                    buildFailed ? 'bg-red-600/80' : 'bg-purple-600'
                  }`}
                  style={{ width: `${zip.progressPercent}%` }}
                />
              </div>
            </>
          )}

          {zip.archiveWarnings?.length > 0 && (
            <div className="mt-3 text-xs text-amber-200/90 bg-amber-950/25 border border-amber-800/50 rounded px-2 py-1.5 space-y-1">
              {zip.archiveWarnings.map((w, idx) => (
                <p key={`${w.code}-${idx}`}>{w.message}</p>
              ))}
            </div>
          )}

          {zip.error && (
            <div className="mt-3 text-xs text-red-300 bg-red-900/30 border border-red-800 rounded px-2 py-1.5">
              {zip.error}
            </div>
          )}

          {showWizard && (
            <section className="mt-4 space-y-4">
              <div className="p-3 rounded border border-slate-600 bg-slate-750/50 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-400 font-medium">Dockerfile candidates</span>
                  <button
                    type="button"
                    disabled={!zip.uploadId || zip.busy}
                    onClick={zip.discoverDockerfile}
                    className="text-xs text-purple-300 hover:text-purple-200 disabled:opacity-50"
                  >
                    Re-scan archive
                  </button>
                </div>
                <McpZipDockerfileList
                  candidates={zip.candidates}
                  selectedPath={zip.selectedDockerfile}
                  onSelect={zip.setSelectedDockerfile}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-slate-400">Mode (required)</span>
                  <select
                    value={zip.mode}
                    onChange={e => zip.setMode(e.target.value)}
                    disabled={zip.busy && isBuilding}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                  >
                    <option value="">— select —</option>
                    <option value="streamable-http">HTTP Streamable</option>
                    <option value="stdio">STDIO (docker image)</option>
                  </select>
                </label>
                {httpMode && (
                  <label className="block">
                    <span className="text-xs text-slate-400">Container listen port (required)</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={zip.containerPort}
                      onChange={e => zip.setContainerPort(e.target.value)}
                      placeholder="8080"
                      disabled={zip.busy && isBuilding}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"
                    />
                  </label>
                )}
              </div>
              {httpMode && (
                <label className="block">
                  <span className="text-xs text-slate-400">HTTP path (required)</span>
                  <input
                    type="text"
                    value={zip.endpointPath}
                    onChange={e => zip.setEndpointPath(e.target.value)}
                    placeholder="/mcp"
                    disabled={zip.busy && isBuilding}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1 font-mono"
                  />
                </label>
              )}

              <label className="block">
                <span className="text-xs text-slate-400">Image tag</span>
                <input
                  type="text"
                  readOnly
                  value={imageTag || ''}
                  placeholder="Set after build"
                  className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1 font-mono text-slate-400"
                />
              </label>

              {zip.wizardStep >= 3 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!canBuild}
                    onClick={zip.startBuild}
                    className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
                  >
                  {isBuilding ? 'Building and testing…' : 'Build and test'}
                </button>
                {buildBlocked && (
                  <span className="text-xs text-red-300/90">Fix preflight issues before building.</span>
                )}
              </div>
            )}

              {showLog && (
                <McpZipBuildConsole
                  buildLog={zip.buildLog}
                  buildStatus={zip.buildStatus}
                  busy={zip.busy}
                  onCopy={zip.copyBuildLog}
                />
              )}
            </section>
          )}

          {isReady && imageTag && (
            <section className="mt-4 p-4 rounded-lg border border-emerald-800/50 bg-emerald-950/20 space-y-3">
              <p className="text-sm text-emerald-100/90">
                {zip.buildStatus?.status === 'ready'
                  ? 'Image is ready and smoke discover found tools.'
                  : 'Image built successfully. Discover tools below, then import.'}
              </p>
              <p className="text-xs font-mono text-emerald-100 break-all">{imageTag}</p>
              {zip.buildStatus.discover_tool_count != null && !showDiscovered && (
                <p className="text-xs text-emerald-300/80">
                  {zip.buildStatus.discover_tool_count} tool(s) found in smoke run
                </p>
              )}
              <button
                type="button"
                onClick={handleContinue}
                disabled={discover?.discovering}
                className="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-500 rounded disabled:opacity-50"
              >
                {discover?.discovering ? 'Discovering tools…' : 'Continue to Add and Configure'}
              </button>
              {discover && (
                <McpDiscoveredToolsPanel
                  discoveredTools={discover.discoveredTools}
                  selectedDiscovered={discover.selectedDiscovered}
                  onToggleAllDiscovered={discover.toggleAllDiscovered}
                  onDiscoveredCheckChange={discover.onDiscoveredCheckChange}
                  onImport={discover.importDiscoveredTools}
                  importSaving={discover.importSaving}
                  discovering={discover.discovering}
                />
              )}
            </section>
          )}
        </div>
      </div>

      <McpBuiltImagesPanel zip={zip} />
    </div>
  )
}
