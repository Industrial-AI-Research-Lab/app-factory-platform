import { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, Brain, Wrench, CheckCircle, XCircle, Loader } from 'lucide-react'

/**
 * ThinkingBlock - Displays a collapsible thinking/reasoning section
 * Similar to Cursor/Windsurf "Thought for X seconds" UI
 */
export function ThinkingBlock({ content, thinkingTime, isStreaming = false }) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  const formattedTime = thinkingTime 
    ? `${Math.round(thinkingTime)}s`
    : isStreaming ? '...' : '0s'
  
  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-300 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        <Brain className="w-4 h-4 text-purple-400" />
        <span>
          {isStreaming ? (
            <>Thinking<span className="animate-pulse">...</span></>
          ) : (
            <>Thought for {formattedTime}</>
          )}
        </span>
      </button>
      
      {isExpanded && content && (
        <div className="mt-2 ml-6 pl-4 border-l-2 border-purple-500/30 text-sm text-slate-300 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  )
}

/**
 * ToolCallBlock - Displays a tool call with its result
 */
export function ToolCallBlock({ 
  name, 
  arguments: args, 
  result, 
  status = 'pending',
  isStreaming = false 
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  const statusIcon = {
    pending: <Loader className="w-4 h-4 text-blue-400 animate-spin" />,
    executing: <Loader className="w-4 h-4 text-yellow-400 animate-spin" />,
    completed: <CheckCircle className="w-4 h-4 text-green-400" />,
    error: <XCircle className="w-4 h-4 text-red-400" />,
  }[status] || <Wrench className="w-4 h-4 text-slate-400" />
  
  const statusText = {
    pending: 'Calling',
    executing: 'Executing',
    completed: 'Completed',
    error: 'Failed',
  }[status] || status
  
  // Parse arguments for display
  let parsedArgs = args
  try {
    if (typeof args === 'string') {
      parsedArgs = JSON.parse(args)
    }
  } catch {
    // Keep as string
  }
  
  return (
    <div className="my-2 bg-slate-800/50 rounded-lg border border-slate-700/50">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400" />
        )}
        {statusIcon}
        <span className="text-slate-300 font-mono">{name}</span>
        <span className="text-slate-500 text-xs ml-auto">{statusText}</span>
      </button>
      
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Arguments */}
          {parsedArgs && (
            <div>
              <div className="text-xs text-slate-500 mb-1">Arguments:</div>
              <pre className="text-xs bg-slate-900/50 p-2 rounded overflow-x-auto text-slate-300">
                {typeof parsedArgs === 'string' ? parsedArgs : JSON.stringify(parsedArgs, null, 2)}
              </pre>
            </div>
          )}
          
          {/* Result */}
          {result && (
            <div>
              <div className="text-xs text-slate-500 mb-1">Result:</div>
              <pre className={`text-xs p-2 rounded overflow-x-auto ${
                status === 'error' ? 'bg-red-900/20 text-red-300' : 'bg-slate-900/50 text-slate-300'
              }`}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * StreamingContent - Combines thinking blocks, tool calls, and text output
 */
export function StreamingContent({ 
  thinkingBlocks = [], 
  toolCalls = [], 
  textContent = '',
  isStreaming = false,
  currentThinking = null,
}) {
  return (
    <div className="space-y-2">
      {/* Completed thinking blocks */}
      {thinkingBlocks.map((block, idx) => (
        <ThinkingBlock 
          key={`thinking-${idx}`}
          content={block.content}
          thinkingTime={block.thinking_time || block.thinkingTime}
        />
      ))}
      
      {/* Current streaming thinking */}
      {currentThinking && (
        <ThinkingBlock 
          content={currentThinking.content}
          isStreaming={true}
        />
      )}
      
      {/* Tool calls */}
      {toolCalls.map((tc, idx) => (
        <ToolCallBlock
          key={`tool-${tc.call_id || idx}`}
          name={tc.name}
          arguments={tc.arguments}
          result={tc.result}
          status={tc.status}
        />
      ))}
      
      {/* Text content */}
      {textContent && (
        <div className="text-slate-200 whitespace-pre-wrap">
          {textContent}
          {isStreaming && <span className="animate-pulse">|</span>}
        </div>
      )}
    </div>
  )
}

export default StreamingContent
