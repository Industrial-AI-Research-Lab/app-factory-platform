import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'

import { apiFetch } from '../../utils_api'
import {
  buildResearchInteractionResponse,
  buildResearchRefineFeedback,
  normalizeResearchPapers,
} from './researchHitlUtils'

const RESEARCH_REVIEW_TYPES = new Set([
  'literature_selection_review',
  'research_answer_review',
])

export function isResearchReviewInteraction(type) {
  return RESEARCH_REVIEW_TYPES.has(String(type || '').trim())
}

export default function ResearchReviewControls({
  data,
  projectId,
  approvalId,
  interactionType,
  onInteractionChange,
  onRefined,
}) {
  const papers = useMemo(() => normalizeResearchPapers(data), [data])
  const isLiteratureSelection = interactionType === 'literature_selection_review'
  const paperIds = useMemo(() => papers.map((paper) => paper.id), [papers])
  const [selectedPaperIds, setSelectedPaperIds] = useState(() => papers.map((paper) => paper.id))
  const [downloadSelected, setDownloadSelected] = useState(isLiteratureSelection)
  const [requireSources, setRequireSources] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isLiteratureSelection || !paperIds.length) return
    setSelectedPaperIds((prev) => {
      const valid = prev.filter((id) => paperIds.includes(id))
      if (valid.length) return valid
      return paperIds
    })
  }, [isLiteratureSelection, paperIds])

  const selectedPapers = useMemo(
    () => papers.filter((paper) => selectedPaperIds.includes(paper.id)),
    [papers, selectedPaperIds],
  )

  const decision = feedbackText.trim()
    ? 'revise'
    : isLiteratureSelection
      ? 'approve_selected'
      : 'approve'

  const interactionResponse = useMemo(
    () => buildResearchInteractionResponse({
      interactionType,
      decision,
      selectedPaperIds,
      downloadSelected,
      requireSources,
      feedbackText,
    }),
    [decision, downloadSelected, feedbackText, interactionType, requireSources, selectedPaperIds],
  )

  const approvalFeedback = useMemo(
    () => buildResearchRefineFeedback({
      interactionType,
      decision,
      selectedPapers,
      feedbackText,
      downloadSelected,
      requireSources,
    }),
    [decision, downloadSelected, feedbackText, interactionType, requireSources, selectedPapers],
  )

  useEffect(() => {
    if (!onInteractionChange) return
    onInteractionChange({ interactionResponse, approvalFeedback })
  }, [approvalFeedback, interactionResponse, onInteractionChange])

  const togglePaper = (paperId) => {
    setSelectedPaperIds((prev) => (
      prev.includes(paperId)
        ? prev.filter((id) => id !== paperId)
        : [...prev, paperId]
    ))
  }

  const requestChanges = async () => {
    if (submitting || !feedbackText.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const resp = await apiFetch(`/projects/${projectId}/refine/literature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_id: approvalId,
          feedback: approvalFeedback,
          interaction_response: {
            ...interactionResponse,
            decision: 'revise',
          },
        }),
      })
      if (!resp.ok) {
        const text = await resp.text()
        setError(`${resp.status}: ${text}`.slice(0, 300))
        return
      }
      setFeedbackText('')
      if (onRefined) onRefined()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (!isResearchReviewInteraction(interactionType)) return null

  return (
    <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-4">
      <div className="space-y-3">
        {isLiteratureSelection && papers.length > 0 && (
          <div className="space-y-2">
            {papers.map((paper) => (
              <label
                key={paper.id}
                className="flex items-start gap-3 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-slate-200"
              >
                <input
                  type="checkbox"
                  checked={selectedPaperIds.includes(paper.id)}
                  onChange={() => togglePaper(paper.id)}
                  className="mt-1 h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500 focus:ring-blue-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium text-slate-100">{paper.title}</span>
                  <span className="mt-1 block text-xs text-slate-400">
                    {[paper.year, paper.source, paper.doi].filter(Boolean).join(' | ') || paper.id}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {isLiteratureSelection && (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={downloadSelected}
              onChange={(e) => setDownloadSelected(e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500 focus:ring-blue-500"
            />
            <span>Use/download selected PDFs for the next steps</span>
          </label>
        )}

        {!isLiteratureSelection && (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={requireSources}
              onChange={(e) => setRequireSources(e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500 focus:ring-blue-500"
            />
            <span>Ask ResearchAgent to add or verify sources</span>
          </label>
        )}

        <textarea
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          placeholder={isLiteratureSelection ? 'Requested changes to literature search' : 'Requested changes to research answer'}
        />

        {error && (
          <div className="rounded-md border border-red-700/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={requestChanges}
          disabled={submitting || !feedbackText.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          <RotateCcw className="h-4 w-4" />
          {submitting ? 'Submitting...' : 'Request changes'}
        </button>
      </div>
    </div>
  )
}
