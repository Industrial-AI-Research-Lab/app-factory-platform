import { memo } from 'react'
import { Handle, Position } from 'reactflow'

function PhaseNode({ data, selected }) {
  return (
    <div
      className={`min-w-[180px] bg-slate-800 border-2 rounded-lg shadow-lg cursor-pointer
        ${selected ? 'border-blue-300 ring-2 ring-blue-400/40' : 'border-blue-500'}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-blue-400 !border-blue-600"
      />
      <div className="px-3 py-1.5 bg-blue-900/40 border-b border-blue-700/50 rounded-t-lg">
        <span className="text-blue-300 text-[10px] font-semibold uppercase tracking-wider">Phase</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-slate-200 text-sm font-medium truncate">
          {data.phase_label || data.label || data.id || 'Phase'}
        </div>
        {data.task_type && (
          <div className="text-slate-400 text-xs mt-0.5 truncate">
            task: {data.task_type}
          </div>
        )}
        {data.agent_type && (
          <div className="text-slate-500 text-xs truncate">
            agent: {data.agent_type}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-blue-400 !border-blue-600"
      />
    </div>
  )
}

export default memo(PhaseNode)
