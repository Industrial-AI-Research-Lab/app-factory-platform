import { memo } from 'react'
import { Handle, Position } from 'reactflow'

function EndNode({ data, selected }) {
  return (
    <div
      className={`w-16 h-16 rounded-full bg-red-900/60 border-2 flex items-center justify-center cursor-pointer
        ${selected ? 'border-red-300 ring-2 ring-red-400/40' : 'border-red-500'}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-red-400 !border-red-600"
      />
      <span className="text-red-300 text-xs font-bold tracking-wide">END</span>
    </div>
  )
}

export default memo(EndNode)
