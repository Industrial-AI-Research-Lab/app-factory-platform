import { CheckCircle, Circle, ChevronRight, ChevronDown, Layers, Clock, Link2, AlertCircle } from 'lucide-react'
import { useState } from 'react'

export default function PlanDisplay({ data }) {
  // Handle both direct plan data and wrapped {plan: {...}} structure
  const planData = data?.context_snapshot?.plan || data?.plan || data
  
  if (!planData || !planData.tasks) {
    return (
      <div className="text-slate-400 p-4">
        No plan data available
        {data && (
          <pre className="text-xs mt-2 text-slate-500">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  const mainGoal = planData.main_goal || planData.goal || "Project Goal"
  const tasks = planData.tasks || []

  return (
    <div className="space-y-6">
      {/* Main Goal */}
      <div className="bg-gradient-to-r from-blue-900/50 to-purple-900/50 rounded-lg p-4 border border-blue-700">
        <div className="flex items-center gap-2 mb-2">
          <Layers className="w-5 h-5 text-blue-400" />
          <h3 className="text-lg font-semibold text-blue-100">Project Goal</h3>
        </div>
        <p className="text-slate-200 text-base">{mainGoal}</p>
        <div className="mt-3 flex items-center gap-4 text-sm">
          <span className="text-slate-400">
            Total Tasks: <span className="text-blue-400 font-semibold">{countAllTasks(tasks)}</span>
          </span>
          <span className="text-slate-400">
            Main Tasks: <span className="text-blue-400 font-semibold">{tasks.length}</span>
          </span>
        </div>
      </div>

      {/* Task List */}
      <div className="space-y-3">
        {tasks.map((task, idx) => (
          <TaskCard key={task.task_id || idx} task={task} index={idx + 1} />
        ))}
      </div>

      {/* Summary Stats */}
      <TaskSummary tasks={tasks} />
    </div>
  )
}

function TaskCard({ task, index, isSubtask = false, depth = 0 }) {
  const [isExpanded, setIsExpanded] = useState(!isSubtask)
  
  // Handle both string subtasks and object subtasks
  const taskObj = typeof task === 'string' ? { description: task } : task
  const hasSubtasks = taskObj.subtasks && taskObj.subtasks.length > 0
  
  const complexityColor = {
    1: 'bg-green-900 text-green-200',
    2: 'bg-blue-900 text-blue-200',
    3: 'bg-yellow-900 text-yellow-200',
    4: 'bg-orange-900 text-orange-200',
    5: 'bg-red-900 text-red-200'
  }[taskObj.complexity || 3] || 'bg-slate-700 text-slate-300'

  const typeColor = {
    'setup': 'bg-purple-900 text-purple-200',
    'coding': 'bg-blue-900 text-blue-200',
    'testing': 'bg-green-900 text-green-200',
    'integration': 'bg-yellow-900 text-yellow-200',
    'deployment': 'bg-orange-900 text-orange-200',
    'documentation': 'bg-slate-700 text-slate-300'
  }[taskObj.type?.toLowerCase()] || 'bg-slate-700 text-slate-300'

  const indentClass = depth > 0 ? `ml-${Math.min(depth * 6, 12)}` : ''

  return (
    <div className={`${indentClass}`}>
      <div className={`bg-slate-800 rounded-lg border ${
        isSubtask ? 'border-slate-700' : 'border-slate-600'
      } overflow-hidden`}>
        {/* Task Header */}
        <div 
          className={`p-4 ${hasSubtasks ? 'cursor-pointer hover:bg-slate-750' : ''}`}
          onClick={() => hasSubtasks && setIsExpanded(!isExpanded)}
        >
          <div className="flex items-start gap-3">
            {/* Expand/Collapse Icon */}
            {hasSubtasks ? (
              isExpanded ? (
                <ChevronDown className="w-5 h-5 text-slate-400 mt-0.5 flex-shrink-0" />
              ) : (
                <ChevronRight className="w-5 h-5 text-slate-400 mt-0.5 flex-shrink-0" />
              )
            ) : (
              <Circle className="w-5 h-5 text-slate-600 mt-0.5 flex-shrink-0" />
            )}

            {/* Task Content */}
            <div className="flex-1 min-w-0">
              {/* Task Number & Description */}
              <div className="flex items-start gap-2 mb-2">
                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                  isSubtask ? 'bg-slate-700 text-slate-300' : 'bg-blue-900 text-blue-200'
                }`}>
                  {isSubtask ? '↳' : `#${index}`}
                </span>
                <h4 className="text-slate-100 font-medium flex-1">
                  {taskObj.description || taskObj.name || 'Unnamed task'}
                </h4>
              </div>

              {/* Task Metadata */}
              <div className="flex flex-wrap gap-2 mb-2">
                {/* Type */}
                {taskObj.type && (
                  <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>
                    {taskObj.type}
                  </span>
                )}

                {/* Complexity */}
                {taskObj.complexity && (
                  <span className={`px-2 py-0.5 rounded text-xs ${complexityColor}`}>
                    Complexity: {taskObj.complexity}/5
                  </span>
                )}

                {/* Subtask Count */}
                {hasSubtasks && (
                  <span className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-300">
                    {taskObj.subtasks.length} subtask{taskObj.subtasks.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Dependencies */}
              {taskObj.dependencies && taskObj.dependencies.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                  <Link2 className="w-3 h-3" />
                  <span>Depends on: {taskObj.dependencies.join(', ')}</span>
                </div>
              )}

              {/* Input/Output Specs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                {taskObj.input_spec && Object.keys(taskObj.input_spec).length > 0 && (
                  <div className="bg-slate-900 rounded p-2 border border-slate-700">
                    <div className="text-slate-400 mb-1">Input:</div>
                    <div className="text-slate-300">
                      {typeof taskObj.input_spec === 'string' 
                        ? taskObj.input_spec 
                        : Object.entries(taskObj.input_spec).map(([k, v]) => `${k}: ${v}`).join(', ')
                      }
                    </div>
                  </div>
                )}

                {taskObj.output_spec && Object.keys(taskObj.output_spec).length > 0 && (
                  <div className="bg-slate-900 rounded p-2 border border-slate-700">
                    <div className="text-slate-400 mb-1">Output:</div>
                    <div className="text-slate-300">
                      {typeof taskObj.output_spec === 'string'
                        ? taskObj.output_spec
                        : Object.entries(taskObj.output_spec).map(([k, v]) => `${k}: ${v}`).join(', ')
                      }
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Subtasks */}
        {hasSubtasks && isExpanded && (
          <div className="border-t border-slate-700 bg-slate-900/50 p-3 space-y-2">
            {taskObj.subtasks.map((subtask, subIdx) => (
              <TaskCard 
                key={subtask.task_id || subIdx} 
                task={subtask} 
                index={`${index}.${subIdx + 1}`}
                isSubtask={true}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TaskSummary({ tasks }) {
  const stats = calculateStats(tasks)

  return (
    <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">Plan Summary</h3>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Total Tasks */}
        <div className="text-center">
          <div className="text-2xl font-bold text-blue-400">{stats.totalTasks}</div>
          <div className="text-xs text-slate-400">Total Tasks</div>
        </div>

        {/* By Type */}
        <div className="text-center">
          <div className="text-2xl font-bold text-purple-400">{stats.byType.coding || 0}</div>
          <div className="text-xs text-slate-400">Coding Tasks</div>
        </div>

        {/* By Complexity */}
        <div className="text-center">
          <div className="text-2xl font-bold text-yellow-400">
            {stats.avgComplexity.toFixed(1)}
          </div>
          <div className="text-xs text-slate-400">Avg Complexity</div>
        </div>

        {/* Dependencies */}
        <div className="text-center">
          <div className="text-2xl font-bold text-green-400">{stats.withDependencies}</div>
          <div className="text-xs text-slate-400">With Dependencies</div>
        </div>
      </div>

      {/* Breakdown by Type */}
      {Object.keys(stats.byType).length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-700">
          <div className="text-xs text-slate-400 mb-2">Task Types:</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byType).map(([type, count]) => (
              <span key={type} className="px-2 py-1 bg-slate-700 text-slate-300 rounded text-xs">
                {type}: {count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Helper functions
function countAllTasks(tasks) {
  let count = tasks.length
  tasks.forEach(task => {
    if (task.subtasks && task.subtasks.length > 0) {
      count += countAllTasks(task.subtasks)
    }
  })
  return count
}

function calculateStats(tasks) {
  let totalTasks = 0
  let totalComplexity = 0
  let withDependencies = 0
  const byType = {}

  function traverse(taskList) {
    taskList.forEach(task => {
      totalTasks++
      
      if (task.complexity) {
        totalComplexity += task.complexity
      }
      
      if (task.dependencies && task.dependencies.length > 0) {
        withDependencies++
      }
      
      if (task.type) {
        const type = task.type.toLowerCase()
        byType[type] = (byType[type] || 0) + 1
      }
      
      if (task.subtasks && task.subtasks.length > 0) {
        traverse(task.subtasks)
      }
    })
  }

  traverse(tasks)

  return {
    totalTasks,
    avgComplexity: totalTasks > 0 ? totalComplexity / totalTasks : 0,
    withDependencies,
    byType
  }
}
