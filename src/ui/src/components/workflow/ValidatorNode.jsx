import { memo } from 'react'
import { Handle, Position } from 'reactflow'

function ValidatorNode({ data, selected }) {
  const checkCount = data.checks?.length ?? 0
  return (
    <div className="relative flex items-center justify-center" style={{ width: 120, height: 120 }}>
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-teal-400 !border-teal-600"
        style={{ top: -6 }}
      />
      {/* Diamond shape via rotated square */}
      <div
        className={`absolute w-[85px] h-[85px] rotate-45 border-2 cursor-pointer
          ${selected ? 'border-teal-300 ring-2 ring-teal-400/40 bg-teal-900/50' : 'border-teal-500 bg-teal-900/30'}`}
      />
      {/* Label (not rotated) */}
      <div className="relative z-10 text-center pointer-events-none">
        <div className="text-teal-300 text-[10px] font-semibold uppercase tracking-wider max-w-[90px] truncate">
          {checkCount} check{checkCount === 1 ? '' : 's'}
        </div>
        <div className="text-slate-200 text-xs font-medium mt-0.5 max-w-[90px] truncate">
          {data.label || data.id || 'Validator'}
        </div>
      </div>
      {/* Approved handle (left-bottom) — green */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="approved"
        className="!w-3 !h-3 !bg-green-400 !border-green-600"
        style={{ left: '35%', bottom: -6 }}
      />
      {/* Rejected handle (right-bottom) — red */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="rejected"
        className="!w-3 !h-3 !bg-red-400 !border-red-600"
        style={{ left: '65%', bottom: -6 }}
      />
    </div>
  )
}

export default memo(ValidatorNode)
