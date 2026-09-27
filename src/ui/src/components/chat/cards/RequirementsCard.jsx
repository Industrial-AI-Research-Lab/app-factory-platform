import { CheckCircle2, HelpCircle } from 'lucide-react'
import { truncatePreviewText } from './previewUtils'

function formatConfidence(value) {
  if (value == null) return null
  const num = Number(value)
  if (Number.isNaN(num)) return null
  if (num >= 0 && num <= 1) return `${Math.round(num * 100)}%`
  if (num > 1 && num <= 100) return `${Math.round(num)}%`
  return String(value)
}

function readNeedsHumanEntry(item) {
  if (typeof item === 'string') return { question: item, note: '' }
  if (!item || typeof item !== 'object') return { question: String(item), note: '' }
  return {
    question: item.question || item.prompt || 'Needs input',
    note: item.why_needs_human || item.reason || '',
  }
}

function formatClarityScore(value) {
  if (value == null) return null
  const num = Number(value)
  if (Number.isNaN(num)) return String(value)
  if (num >= 0 && num <= 1) return `${Math.round(num * 100)}%`
  return `${Math.round(num)}%`
}

function previewText(value) {
  return truncatePreviewText(value).text
}

export default function RequirementsCard({ data }) {
  const answered = data?.answered_questions || data?.questions_answered_by_ai || []
  const needsHuman = data?.needs_human || data?.questions_needing_human || []
  const analysis = data?.analysis && typeof data.analysis === 'object' ? data.analysis : null
  const questions = Array.isArray(data?.questions) ? data.questions : []
  const status = data?.status

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
        <h3 className="text-sm font-semibold text-slate-100">Requirements</h3>
      </div>

      {analysis && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <h4 className="text-xs font-semibold text-slate-200 mb-2">Analysis</h4>
          <div className="space-y-1 text-xs text-slate-300">
            {analysis.project_type && (
              <p>
                <span className="text-slate-400">Project type:</span> {previewText(analysis.project_type)}
              </p>
            )}
            {analysis.clarity_score != null && (
              <p>
                <span className="text-slate-400">Clarity:</span> {formatClarityScore(analysis.clarity_score)}
              </p>
            )}
            {Array.isArray(analysis.missing_info) && analysis.missing_info.length > 0 && (
              <div className="pt-1">
                <p className="text-slate-400 mb-1">Missing info:</p>
                <ul className="space-y-1">
                  {analysis.missing_info.map((item, index) => (
                    <li key={`missing-${index}`} className="text-slate-300">- {previewText(item)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <h4 className="text-xs font-semibold text-slate-200 mb-2">Clarifying Questions</h4>
          <div className="space-y-2">
            {questions.map((question, index) => (
              <div key={`question-${index}`} className="rounded border border-slate-700 bg-slate-900/60 p-2">
                <p className="text-sm text-slate-100">{previewText(question?.question || String(question))}</p>
                {(question?.category || question?.priority) && (
                  <p className="text-[11px] text-slate-400 mt-1">
                    {previewText([question?.category, question?.priority].filter(Boolean).join(' - '))}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {answered.length > 0 && (
        <div className="space-y-3">
          {answered.map((item, index) => {
            const confidence = formatConfidence(item?.confidence)
            return (
              <div key={`${item?.question || 'q'}-${index}`} className="rounded-lg border border-slate-700 bg-slate-800/70 p-3">
                <p className="text-xs text-slate-300">
                  <span className="font-medium text-slate-200">Q:</span> {previewText(item?.question || 'Unknown question')}
                </p>
                <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">{previewText(item?.answer || 'No answer provided')}</p>
                {confidence && (
                  <p className="mt-2 text-[11px] text-slate-400">Confidence: {confidence}</p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {needsHuman.length > 0 && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-900/10 p-3">
          <div className="flex items-center gap-2 mb-2">
            <HelpCircle className="w-4 h-4 text-amber-400" />
            <h4 className="text-xs font-semibold text-amber-200">Needs Human Input</h4>
          </div>
          <ul className="space-y-2">
            {needsHuman.map((item, index) => {
              const entry = readNeedsHumanEntry(item)
              return (
                <li key={`${entry.question}-${index}`} className="text-xs text-amber-100">
                  <p>{previewText(entry.question)}</p>
                  {entry.note && <p className="text-[11px] text-amber-300/90">{previewText(entry.note)}</p>}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {status && (
        <p className="text-[11px] text-slate-400 uppercase tracking-wide">Status: {previewText(status)}</p>
      )}

      {!analysis && questions.length === 0 && answered.length === 0 && needsHuman.length === 0 && (
        <p className="text-xs text-slate-400">No requirements fields found in this payload.</p>
      )}
    </div>
  )
}
