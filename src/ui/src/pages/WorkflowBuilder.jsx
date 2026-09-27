import { useState, useCallback } from 'react'
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
} from 'reactflow'
import 'reactflow/dist/style.css'
import AgentNode from '../components/AgentNode'
import TopNavLinks from '../components/TopNavLinks'
import { Save, Plus } from 'lucide-react'
import { notify } from '../utils_notify'

const nodeTypes = {
  agent: AgentNode,
}

const initialNodes = [
  {
    id: '1',
    type: 'agent',
    position: { x: 250, y: 50 },
    data: { label: 'Requirements Gatherer', agentType: 'requirements_gatherer' },
  },
  {
    id: '2',
    type: 'agent',
    position: { x: 250, y: 200 },
    data: { label: 'Planner', agentType: 'planner' },
  },
  {
    id: '3',
    type: 'agent',
    position: { x: 100, y: 350 },
    data: { label: 'Coding Agent', agentType: 'coding' },
  },
  {
    id: '4',
    type: 'agent',
    position: { x: 400, y: 350 },
    data: { label: 'QA Agent', agentType: 'qa' },
  },
]

const initialEdges = [
  { id: 'e1-2', source: '1', target: '2', animated: true },
  { id: 'e2-3', source: '2', target: '3', animated: true },
  { id: 'e2-4', source: '2', target: '4', animated: true },
]

export default function WorkflowBuilder() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [selectedNode, setSelectedNode] = useState(null)

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node)
  }, [])

  const saveWorkflow = () => {
    const workflow = {
      nodes,
      edges,
      timestamp: new Date().toISOString()
    }
    console.log('Saving workflow:', workflow)
    // TODO: Send to backend
    notify({ title: 'Saved', message: 'Workflow saved (not yet implemented)', variant: 'info', ttl: 3000 })
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="px-8 py-6 border-b border-slate-800">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold text-slate-100">Workflow Builder</h1>
          <TopNavLinks />
        </div>
      </div>
      <div className="flex h-[calc(100vh-140px)] p-6">
        {/* Sidebar */}
        <div className="w-64 bg-slate-800 border-r border-slate-700 p-4">
          <h2 className="text-lg font-semibold text-slate-200 mb-4">Agent Library</h2>
          
          <div className="space-y-2">
            {[
              { type: 'requirements_gatherer', label: 'Requirements Gatherer' },
              { type: 'planner', label: 'Planner' },
              { type: 'coding', label: 'Coding Agent' },
              { type: 'qa', label: 'QA Agent' },
              { type: 'integration', label: 'Integration Agent' },
              { type: 'critic', label: 'Critic Expert' },
            ].map((agent) => (
              <div
                key={agent.type}
                className="bg-slate-700 hover:bg-slate-600 rounded p-3 cursor-move transition-colors"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/reactflow', agent.type)
                  e.dataTransfer.effectAllowed = 'move'
                }}
              >
                <div className="text-sm font-medium text-slate-200">{agent.label}</div>
                <div className="text-xs text-slate-400">{agent.type}</div>
              </div>
            ))}
          </div>

        {selectedNode && (
          <div className="mt-8 pt-8 border-t border-slate-700">
            <h3 className="text-sm font-semibold text-slate-200 mb-2">Node Properties</h3>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-slate-400">ID:</span>
                <span className="text-slate-200 ml-2">{selectedNode.id}</span>
              </div>
              <div>
                <span className="text-slate-400">Type:</span>
                <span className="text-slate-200 ml-2">{selectedNode.data.agentType}</span>
              </div>
              <div>
                <span className="text-slate-400">Label:</span>
                <input
                  type="text"
                  className="ml-2 bg-slate-700 text-slate-200 px-2 py-1 rounded text-xs"
                  value={selectedNode.data.label}
                  onChange={(e) => {
                    setNodes((nds) =>
                      nds.map((node) => {
                        if (node.id === selectedNode.id) {
                          node.data = { ...node.data, label: e.target.value }
                        }
                        return node
                      })
                    )
                  }}
                />
              </div>
            </div>
          </div>
        )}
        </div>

        {/* Canvas */}
        <div className="flex-1 relative">
        <div className="absolute top-4 right-4 z-10">
          <button
            onClick={saveWorkflow}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save Workflow
          </button>
        </div>

          <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
        >
            <Controls />
            <MiniMap />
            <Background variant="dots" gap={12} size={1} />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}
