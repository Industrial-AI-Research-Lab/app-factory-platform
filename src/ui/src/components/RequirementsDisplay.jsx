import { CheckCircle, AlertCircle, Code, Layers, Database, Key } from 'lucide-react'
import { useEffect } from 'react'

export default function RequirementsDisplay({ data, onAnswersChanged, answers }) {
  if (!data || !data.requirements) {
    return (
      <div className="text-slate-400 p-4">
        No requirements data available
      </div>
    )
  }

  const requirements = data.requirements
  // Support both shapes:
  // - Old: { answered_by_ai, needs_human_input, inferred_decisions }
  // - New: fields inside the requirements document itself
  const answeredByAI = data.answered_by_ai || requirements.questions_answered_by_ai || []
  const needsHumanInput = data.needs_human_input || requirements.questions_needing_human || []
  const inferredDecisions = data.inferred_decisions || requirements.inferred_decisions || {}

  return (
    <div className="space-y-6">
      {/* Project Goal */}
      <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
        <h3 className="text-lg font-semibold text-slate-100 mb-2">Project Goal</h3>
        <p className="text-slate-300">{requirements.goal}</p>
        <div className="mt-2 flex items-center gap-4 text-sm">
          <span className="text-slate-400">
            Type: <span className="text-blue-400">{requirements.project_type}</span>
          </span>
          <span className="text-slate-400">
            Clarity: <span className="text-green-400">{Math.round((requirements.clarity_score || 0) * 100)}%</span>
          </span>
        </div>
      </div>

      {/* AI-Answered Questions */}
      {answeredByAI.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle className="w-5 h-5 text-green-400" />
            <h3 className="text-lg font-semibold text-slate-100">
              Questions Answered by AI ({answeredByAI.length})
            </h3>
          </div>
          <div className="space-y-3">
            {answeredByAI.map((qa, idx) => (
              <div key={idx} className="bg-slate-900 rounded p-3 border border-slate-700">
                <div className="text-slate-300 font-medium mb-1">
                  Q: {qa.question}
                </div>
                <div className="text-green-400 mb-1">
                  A: {qa.answer}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">Confidence: {Math.round((qa.confidence || 0) * 100)}%</span>
                  {qa.reasoning && (
                    <span className="text-slate-500">• {qa.reasoning}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inferred Decisions */}
      {inferredDecisions && Object.keys(inferredDecisions).length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <Code className="w-5 h-5 text-blue-400" />
            <h3 className="text-lg font-semibold text-slate-100">Inferred Technical Decisions</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {inferredDecisions.tech_stack && inferredDecisions.tech_stack.length > 0 && (
              <div className="bg-slate-900 rounded p-3">
                <div className="text-slate-400 text-sm mb-1">Tech Stack</div>
                <div className="flex flex-wrap gap-2">
                  {inferredDecisions.tech_stack.map((tech, idx) => (
                    <span key={idx} className="px-2 py-1 bg-blue-900 text-blue-200 rounded text-xs">
                      {tech}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {inferredDecisions.architecture && (
              <div className="bg-slate-900 rounded p-3">
                <div className="text-slate-400 text-sm mb-1">Architecture</div>
                <div className="text-slate-200">{inferredDecisions.architecture}</div>
              </div>
            )}
            {inferredDecisions.deployment && (
              <div className="bg-slate-900 rounded p-3">
                <div className="text-slate-400 text-sm mb-1">Deployment</div>
                <div className="text-slate-200">{inferredDecisions.deployment}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Technical Stack from Requirements */}
      {requirements.technical_stack && (
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-semibold text-slate-100">Technical Stack</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {requirements.technical_stack.languages && requirements.technical_stack.languages.length > 0 && (
              <div className="bg-slate-900 rounded p-3">
                <div className="text-slate-400 text-sm mb-1">Languages</div>
                <div className="text-slate-200">{requirements.technical_stack.languages.join(', ')}</div>
              </div>
            )}
            {requirements.technical_stack.architecture && (
              <div className="bg-slate-900 rounded p-3">
                <div className="text-slate-400 text-sm mb-1">Architecture</div>
                <div className="text-slate-200">{requirements.technical_stack.architecture}</div>
              </div>
            )}
            {requirements.technical_stack.deployment_target && (
              <div className="bg-slate-900 rounded p-3">
                <div className="text-slate-400 text-sm mb-1">Deployment Target</div>
                <div className="text-slate-200">{requirements.technical_stack.deployment_target}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Functional Requirements */}
      {requirements.functional_requirements && requirements.functional_requirements.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 className="text-lg font-semibold text-slate-100 mb-3">Functional Requirements</h3>
          <ul className="space-y-2">
            {requirements.functional_requirements.map((req, idx) => (
              <li key={idx} className="flex items-start gap-2 text-slate-300">
                <span className="text-green-400 mt-1">•</span>
                <span>{req}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Questions Needing Human Input */}
      {needsHumanInput.length > 0 && (
        <div className="bg-amber-900/20 rounded-lg p-4 border border-amber-700">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="w-5 h-5 text-amber-400" />
            <h3 className="text-lg font-semibold text-amber-100">
              Questions Requiring Your Input ({needsHumanInput.length})
            </h3>
          </div>
          <div className="space-y-3">
            {needsHumanInput.map((q, idx) => (
              <div key={idx} className="bg-slate-900/50 rounded p-3 border border-amber-800">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-400 mt-1 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="text-amber-100 font-medium mb-1">
                      {q.question}
                    </div>
                    {q.why_needs_human && (
                      <div className="text-amber-300 text-sm mb-1">
                        Why: {q.why_needs_human}
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`px-2 py-0.5 rounded ${
                        q.priority === 'critical' ? 'bg-red-900 text-red-200' :
                        q.priority === 'important' ? 'bg-amber-900 text-amber-200' :
                        'bg-slate-700 text-slate-300'
                      }`}>
                        {q.priority}
                      </span>
                    </div>
                    <input
                      type="text"
                      placeholder="Your answer..."
                      className="mt-2 w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                      value={(answers && answers[q.question]) || ''}
                      onChange={(e) => {
                        const next = { ...(answers || {}) }
                        next[q.question] = e.target.value
                        if (onAnswersChanged) onAnswersChanged(next)
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-slate-900/50 rounded border border-amber-800">
            <p className="text-amber-300 text-sm">
              💡 <strong>Tip:</strong> Answer the questions above to help the AI better understand your requirements. 
              You can also approve now and the AI will use sensible defaults.
            </p>
          </div>
        </div>
      )}

      {/* Missing Info Warning */}
      {requirements.missing_info && requirements.missing_info.length > 0 && needsHumanInput.length === 0 && (
        <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-600">
          <h3 className="text-sm font-semibold text-slate-400 mb-2">Additional Context (Optional)</h3>
          <ul className="space-y-1">
            {requirements.missing_info.map((info, idx) => (
              <li key={idx} className="text-slate-500 text-sm">• {info}</li>
            ))}
          </ul>
          <p className="text-slate-500 text-xs mt-2">
            These items were identified but the AI made reasonable assumptions.
          </p>
        </div>
      )}
    </div>
  )
}
