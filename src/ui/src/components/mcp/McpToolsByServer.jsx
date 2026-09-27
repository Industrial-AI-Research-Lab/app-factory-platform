import { useState } from 'react'
import { Activity, ChevronDown, ChevronRight, RotateCcw, Settings, ToggleLeft, ToggleRight } from 'lucide-react'
import { aggregateServerHealthRow } from './healthMerge'
import { healthStatusColor, healthStatusLabel, mcpCategoryLabel } from './helpers'
import { isHttpConnectionSettingsGroup } from './mcpServerGroups'

export default function McpToolsByServer({
  groups,
  loading,
  saving,
  healthResult,
  healthLoading,
  onHealthCheckServer,
  onToggleEnabled,
  onEdit,
  onDelete,
  onRestartServer,
  onDeleteServer,
  onServerSettings,
  isRoot = false,
  selectedServerIds,
  onToggleServerSelected,
}) {
  const [collapsed, setCollapsed] = useState({})

  const toggleGroup = (serverId) => {
    setCollapsed(prev => ({ ...prev, [serverId]: !prev[serverId] }))
  }

  if (!loading && groups.length === 0) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-8 text-center text-slate-500 text-sm">
        No MCP tools found.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const { groupKey, tenantId, serverId, tools, isRestartableZip } = group
        const isCollapsed = collapsed[groupKey] === true
        const hrow = aggregateServerHealthRow(healthResult, serverId)
        const hStatus = hrow?.status
        const serverDeleting = Boolean(saving[`server:${groupKey}`])
        const canDeleteServer = serverId !== '(no server)' && tools.length > 0 && onDeleteServer
        const canSelect = serverId !== '(no server)' && typeof onToggleServerSelected === 'function'
        const canPulse = serverId !== '(no server)' && typeof onHealthCheckServer === 'function'
        return (
          <div key={groupKey} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
            <div className="flex items-center border-b border-slate-700/80">
              {canSelect && (
                <label className="shrink-0 pl-3 flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedServerIds?.[groupKey])}
                    onChange={() => onToggleServerSelected(groupKey)}
                    className="rounded border-slate-600 bg-slate-700"
                    aria-label={`Select server ${serverId}`}
                  />
                </label>
              )}
              <button
                type="button"
                onClick={() => toggleGroup(groupKey)}
                className="flex-1 flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-750 min-w-0"
              >
                {isCollapsed
                  ? <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                <span className="font-mono text-sm text-slate-200 truncate">{serverId}</span>
                <span className="text-xs text-slate-500 shrink-0">{tenantId}</span>
                <span className="text-xs text-slate-500 shrink-0">({tools.length})</span>
                <span className={`text-xs ml-2 truncate ${hStatus ? healthStatusColor(hStatus) : 'text-slate-500'}`}>
                  {hStatus ? healthStatusLabel(hStatus) : 'not checked'}
                  {hrow?.tools_count != null && hrow.tools_count !== tools.length && (
                    <span className="text-slate-500 font-normal">
                      {' '}· {hrow.tools_count} on server
                    </span>
                  )}
                </span>
              </button>
              {canPulse && (
                <button
                  type="button"
                  onClick={() => onHealthCheckServer(group)}
                  disabled={healthLoading}
                  className="shrink-0 mr-2 p-1.5 text-purple-300 hover:text-purple-200 hover:bg-purple-950/40 rounded disabled:opacity-50"
                  title={`Health check ${serverId}`}
                >
                  <Activity className={`w-3.5 h-3.5 ${healthLoading ? 'animate-pulse' : ''}`} />
                </button>
              )}
              {serverId !== '(no server)'
                && typeof onServerSettings === 'function'
                && (isRoot || tenantId !== '__system__')
                && isHttpConnectionSettingsGroup(group) && (
                <button
                  type="button"
                  onClick={() => onServerSettings(group)}
                  disabled={serverDeleting}
                  className="shrink-0 mr-2 p-1.5 text-slate-300 hover:text-white hover:bg-slate-700 rounded disabled:opacity-50"
                  title={`Settings ${serverId}`}
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              )}
              {isRestartableZip && typeof onRestartServer === 'function' && (
                <button
                  type="button"
                  onClick={() => onRestartServer(group)}
                  disabled={serverDeleting}
                  className="shrink-0 mr-2 p-1.5 text-blue-300 hover:text-blue-200 hover:bg-blue-950/40 rounded disabled:opacity-50"
                  title={`Restart ZIP MCP ${serverId}`}
                >
                  <RotateCcw className={serverDeleting ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} />
                </button>
              )}
              {canDeleteServer && (
                <button
                  type="button"
                  onClick={() => onDeleteServer(group)}
                  disabled={serverDeleting}
                  className="shrink-0 mr-3 px-2.5 py-1 text-xs text-red-400 hover:text-red-300 border border-red-900/50 rounded hover:bg-red-950/40 disabled:opacity-50"
                  title={`Delete server ${serverId} and all tools`}
                >
                  {serverDeleting ? 'Deleting…' : 'Delete server'}
                </button>
              )}
            </div>
            {!isCollapsed && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 border-b border-slate-700">
                      <th className="text-left px-4 py-2">ID</th>
                      <th className="text-left px-4 py-2">Name</th>
                      <th className="text-left px-4 py-2">Category</th>
                      <th className="text-center px-4 py-2">Enabled</th>
                      <th className="text-right px-4 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map(tool => {
                      const id = tool.id || tool._id
                      return (
                        <tr key={id} className="border-b border-slate-700/50 hover:bg-slate-750">
                          <td className="px-4 py-2 font-mono text-xs">{id}</td>
                          <td className="px-4 py-2">{tool.name}</td>
                          <td className="px-4 py-2">
                            <span className="text-xs bg-slate-700 px-2 py-0.5 rounded">{mcpCategoryLabel(tool.category)}</span>
                          </td>
                          <td className="px-4 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => onToggleEnabled(tool)}
                              disabled={saving[id]}
                              className="inline-flex items-center"
                            >
                              {tool.enabled
                                ? <ToggleRight className="w-5 h-5 text-green-400" />
                                : <ToggleLeft className="w-5 h-5 text-slate-500" />}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-2 min-w-[110px]">
                              <button type="button" onClick={() => onEdit(tool)} className="px-2 py-1 text-xs text-slate-300 hover:text-white">Edit</button>
                              <button type="button" onClick={() => onDelete(tool)} className="px-2 py-1 text-xs text-red-400 hover:text-red-300">Delete</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
