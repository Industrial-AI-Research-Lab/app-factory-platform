import { memo } from 'react'
import { Handle, Position } from 'reactflow'

function A2aNode({ data, selected }) {
  const hasServer = !!data.server_id
  return (
    <div
      className={`min-w-[180px] bg-slate-800 border-2 rounded-lg shadow-lg cursor-pointer
        ${selected ? 'border-cyan-300 ring-2 ring-cyan-400/40' : 'border-cyan-500'}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-cyan-400 !border-cyan-600"
      />
      <div className="px-3 py-1.5 bg-cyan-900/40 border-b border-cyan-700/50 rounded-t-lg">
        <span className="text-cyan-300 text-[10px] font-semibold uppercase tracking-wider">A2A Agent</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-slate-200 text-sm font-medium truncate">
          {data.label || data.id || 'A2A Agent'}
        </div>
        {hasServer ? (
          <div className="text-slate-500 text-xs mt-0.5 truncate">
            server: {String(data.server_id).slice(0, 8)}…
          </div>
        ) : (
          <div className="text-amber-400 text-xs mt-0.5 truncate">no server set</div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-cyan-400 !border-cyan-600"
      />
    </div>
  )
}

export default memo(A2aNode)
