import { memo } from 'react'
import { Handle, Position } from 'reactflow'

function StartNode({ data, selected }) {
  return (
    <div
      className={`w-16 h-16 rounded-full bg-green-900/60 border-2 flex items-center justify-center cursor-pointer
        ${selected ? 'border-green-300 ring-2 ring-green-400/40' : 'border-green-500'}`}
    >
      <span className="text-green-300 text-xs font-bold tracking-wide">START</span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-green-400 !border-green-600"
      />
    </div>
  )
}

export default memo(StartNode)
