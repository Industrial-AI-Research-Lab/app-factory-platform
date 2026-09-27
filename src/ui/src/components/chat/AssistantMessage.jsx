/**
 * AssistantMessage Component
 * 
 * Renders an AI assistant message in the chat interface.
 */

import { useMemo, useState } from 'react'
import { Bot, Search, ChevronDown } from 'lucide-react'
import AgentInvocationInspector from '../AgentInvocationInspector'
import RequirementsCard from './cards/RequirementsCard'
import PlanningCard from './cards/PlanningCard'
import CodeOutputCard from './cards/CodeOutputCard'
import DeployCard from './cards/DeployCard'
import JsonCard from './cards/JsonCard'
import ResearchReviewDisplay from './ResearchReviewDisplay'
import ResearchStageCard from './research/ResearchStageCard'
import { researchStageOf } from './research/researchStage'
import { truncatePreviewText } from './cards/previewUtils'
import {
  detectCardType,
  parseStructuredContent,
  shouldRenderAsCodeFallback,
} from './cards/messageCardDetection'

export default function AssistantMessage({ message, projectId }) {
  const timestamp = message.created_at 
    ? new Date(message.created_at).toLocaleTimeString() 
    : null

  const agentId = message.data?.agent_id
  const phase = message.data?.phase
  const phaseNormalized = String(phase || '').toLowerCase()
  const content = message.content

  // Captured LLM invocations for this agent's text output, attached by
  // ChatInterface. One per tool round (turnIndex 0-based) — agents that stream
  // text without a thinking block are otherwise unreachable from the Inspector.
  const captures = message._captures || []
  const [inspectorCallId, setInspectorCallId] = useState(null)
  const [roundMenuOpen, setRoundMenuOpen] = useState(false)

  const researchStage = useMemo(() => researchStageOf(message), [message])
  const cardType = useMemo(() => detectCardType(content), [content])
  const parsedContent = useMemo(() => parseStructuredContent(content), [content])
  const shouldRenderCode = useMemo(
    () => shouldRenderAsCodeFallback(content),
    [content]
  )
  const preview = useMemo(() => truncatePreviewText(content), [content])
  const canUsePhaseCard = cardType !== 'code_output'
  const shouldRenderExecutionSummaryCard = useMemo(() => {
    if (phaseNormalized !== 'execution') return false
    if (cardType !== 'text') return false
    if (typeof content !== 'string') return false
    if (!content.trim()) return false
    return true
  }, [phaseNormalized, cardType, content])

  const renderContent = () => {
    if (researchStage) {
      return (
        <ResearchStageCard
          stage={researchStage}
          data={message.data}
          projectId={projectId || message.project_id}
        />
      )
    }

    if (parsedContent && phaseNormalized === 'deploy' && canUsePhaseCard) {
      return <DeployCard data={parsedContent} />
    }

    if (cardType === 'requirements' && parsedContent) {
      return <RequirementsCard data={parsedContent} />
    }

    if (cardType === 'planning' && parsedContent) {
      return <PlanningCard data={parsedContent} />
    }

    if (cardType === 'code_output' && parsedContent) {
      return <CodeOutputCard data={parsedContent} />
    }

    if (cardType === 'deploy' && parsedContent) {
      return <DeployCard data={parsedContent} />
    }

    if (cardType === 'research_papers' && parsedContent) {
      return (
        <ResearchReviewDisplay
          data={{
            search_results: parsedContent,
            user_prompt: message.data?.user_prompt || message.data?.prompt || '',
          }}
        />
      )
    }

    if (cardType === 'json' && parsedContent) {
      return <JsonCard data={parsedContent} />
    }

    if (shouldRenderCode) {
      return (
        <div className="space-y-2">
          <pre className="text-xs text-slate-200 bg-slate-900/80 border border-slate-700 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {preview.text}
          </pre>
          {preview.isTruncated && (
            <p className="text-[11px] text-slate-400">
              Preview truncated to 20,000 characters.
            </p>
          )}
        </div>
      )
    }

    if (shouldRenderExecutionSummaryCard) {
      const summaryPath = agentId
        ? `${String(agentId).split('@')[0] || 'execution'}-summary.md`
        : 'execution-summary.md'

      return (
        <CodeOutputCard
          data={{
            artifacts: [
              {
                path: summaryPath,
                content: preview.text,
                type: 'markdown',
              },
            ],
          }}
        />
      )
    }

    return (
      <div className="space-y-2">
        <div className="text-slate-200 whitespace-pre-wrap break-words">
          {preview.text}
        </div>
        {preview.isTruncated && (
          <p className="text-[11px] text-slate-400">
            Preview truncated to 20,000 characters.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center">
        <Bot className="w-4 h-4 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1 min-w-0">
          <span className="text-sm font-medium text-purple-300 break-all">
            {agentId || 'Assistant'}
          </span>
          {phase && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
              {phase}
            </span>
          )}
          {timestamp && (
            <span className="text-xs text-slate-500">{timestamp}</span>
          )}
          {captures.length > 0 && (
            <div className="relative">
              <button
                onClick={() => {
                  if (captures.length === 1) setInspectorCallId(captures[0].callId)
                  else setRoundMenuOpen((o) => !o)
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-slate-600/60 text-slate-300 hover:bg-slate-700/50 hover:text-slate-100"
                title="Open Inspector: effective prompt, tools, and raw response"
              >
                <Search className="w-3 h-3" /> Inspector
                {captures.length > 1 && (
                  <>
                    <span className="text-slate-500">({captures.length})</span>
                    <ChevronDown className="w-3 h-3" />
                  </>
                )}
              </button>
              {roundMenuOpen && captures.length > 1 && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setRoundMenuOpen(false)} />
                  <div className="absolute z-20 left-0 mt-1 min-w-[150px] rounded-md border border-slate-700 bg-slate-900 shadow-lg py-1">
                  {(() => {
                    // Disambiguate retries. A delegated sub-agent that is re-run
                    // after a reject starts a FRESH conversation at turn_index 0,
                    // so the original and the retry both resolve to the same
                    // "Round N" (turn_index+1) and were previously indistinguishable.
                    // When 2+ captures share a turn_index, suffix them "· try K"
                    // (1-based, oldest→newest — captures are already sorted that way).
                    const perTurn = {}
                    captures.forEach((c) => {
                      const t = c.turnIndex ?? -1
                      perTurn[t] = (perTurn[t] || 0) + 1
                    })
                    const seen = {}
                    return captures.map((cap, i) => {
                      const t = cap.turnIndex ?? i
                      const key = cap.turnIndex ?? -1
                      seen[key] = (seen[key] || 0) + 1
                      const isRetry = (perTurn[key] || 0) > 1
                      const ts = cap.timestamp ? new Date(cap.timestamp) : null
                      return (
                        <button
                          key={cap.callId}
                          onClick={() => { setInspectorCallId(cap.callId); setRoundMenuOpen(false) }}
                          className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700/60 hover:text-slate-100"
                          title={ts ? ts.toLocaleString() : undefined}
                        >
                          <span>
                            Round {t + 1}
                            {isRetry && <span className="text-amber-300/80"> · try {seen[key]}</span>}
                          </span>
                          {cap.stopReason && (
                            <span className="text-slate-500 truncate max-w-[80px]" title={cap.stopReason}>
                              {cap.stopReason}
                            </span>
                          )}
                        </button>
                      )
                    })
                  })()}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {renderContent()}
        {inspectorCallId && (
          <AgentInvocationInspector callId={inspectorCallId} rounds={captures} onClose={() => setInspectorCallId(null)} />
        )}
      </div>
    </div>
  )
}
