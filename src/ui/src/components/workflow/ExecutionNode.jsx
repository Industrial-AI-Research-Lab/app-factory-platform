import { memo } from 'react'
import { Handle, Position } from 'reactflow'

function ExecutionNode({ data, selected }) {
  return (
    <div
      className={`min-w-[180px] bg-slate-800 border-2 rounded-lg shadow-lg cursor-pointer
        ${selected ? 'border-purple-300 ring-2 ring-purple-400/40' : 'border-purple-500'}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-purple-400 !border-purple-600"
      />
      <div className="px-3 py-1.5 bg-purple-900/40 border-b border-purple-700/50 rounded-t-lg">
        <span className="text-purple-300 text-[10px] font-semibold uppercase tracking-wider">Execution</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-slate-200 text-sm font-medium truncate">
          {data.label || data.id || 'Execute Tasks'}
        </div>
        {data.description && (
          <div className="text-slate-400 text-xs mt-0.5 truncate">
            {data.description}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-purple-400 !border-purple-600"
      />
    </div>
  )
}

export default memo(ExecutionNode)
