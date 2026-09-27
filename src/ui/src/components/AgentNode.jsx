import { memo } from 'react'
import { Handle, Position } from 'reactflow'
import { Bot } from 'lucide-react'

const AgentNode = memo(({ data, isConnectable }) => {
  return (
    <div className="px-4 py-3 shadow-lg rounded-lg border-2 border-blue-500 bg-slate-800">
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        className="w-3 h-3"
      />
      
      <div className="flex items-center gap-2">
        <Bot className="w-4 h-4 text-blue-400" />
        <div>
          <div className="text-sm font-medium text-slate-100">{data.label}</div>
          <div className="text-xs text-slate-400">{data.agentType}</div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className="w-3 h-3"
      />
    </div>
  )
})

AgentNode.displayName = 'AgentNode'

export default AgentNode
