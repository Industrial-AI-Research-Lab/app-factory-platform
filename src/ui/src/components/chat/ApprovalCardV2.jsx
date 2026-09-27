/**
 * ApprovalCardV2 Component
 * 
 * Renders approval cards for the unified message system.
 * This is a simplified version that works with the new message schema.
 */

import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import PlanDisplay from '../PlanDisplay'
import OutputDisplay from '../OutputDisplay'
import PlanReviewControls from './PlanReviewControls'
import ResearchReviewControls, { isResearchReviewInteraction } from './ResearchReviewControls'
import ResearchReviewDisplay from './ResearchReviewDisplay'
import AgentResultDisplay from './AgentResultDisplay'
import OntologyReview from './ontology/OntologyReview'
import ManifestReview from './ManifestReview'
import BriefReview from './research/BriefReview'
import CalculatorsReview from './research/CalculatorsReview'
import ReportPublishReview from './ReportPublishReview'
import {reviewKind} from './ontology/ontologyPayload'
import { hasResearchReviewPayload } from './researchHitlUtils'
import { apiFetch } from '../../utils_api'
import {HitlCard, DeployDisplay} from './ApprovalLegacyDisplays'

// Stable gate_node_id → renderer map. Keys MUST match the `node["id"]` values
// the workflow engine writes into approval_data.gate_node_id at the gate
// (workflow_engine._handle_approval_gate) and the `deploy` id seeded by
// `orchestrator._seed_deploy_approval` for the post-completion deploy intent.
// These renderers read the reviewed payload out of data.context_snapshot
// (plan/artifacts), so they win for the gates that have an entry; gates
// without one (e.g. gate_req) fall through to the agent_result_review
// contract, then to the raw JSON disclosure. The renderers accept
// `answers`/`onAnswersChanged` but ignore them, keeping the dispatch uniform.
const GATE_RENDERERS = {
  gate_plan: PlanDisplay,
  gate_output: OutputDisplay,
  deploy: DeployDisplay,
}

const STATUS_CONFIG = {
  pending: {
    bgClass: 'bg-amber-900/20 border-amber-700/50',
    headerClass: 'text-amber-200',
    icon: AlertTriangle,
    iconClass: 'text-amber-400',
    borderClass: 'border-amber-700/30'
  },
  approved: {
    bgClass: 'bg-green-900/20 border-green-700/50',
    headerClass: 'text-green-200',
    icon: CheckCircle,
    iconClass: 'text-green-400',
    borderClass: 'border-green-700/30'
  },
  rejected: {
    bgClass: 'bg-red-900/20 border-red-700/50',
    headerClass: 'text-red-200',
    icon: XCircle,
    iconClass: 'text-red-400',
    borderClass: 'border-red-700/30'
  },
  superseded: {
    bgClass: 'bg-slate-800/50 border-slate-600/50',
    headerClass: 'text-slate-400',
    icon: XCircle,
    iconClass: 'text-slate-500',
    borderClass: 'border-slate-600/30'
  },
  cancelled: {
    bgClass: 'bg-slate-800/50 border-slate-600/50',
    headerClass: 'text-slate-400',
    icon: XCircle,
    iconClass: 'text-slate-500',
    borderClass: 'border-slate-600/30'
  }
}

const REVIEWS = { ontology: OntologyReview, manifest: ManifestReview, brief: BriefReview, publish: ReportPublishReview, calculators: CalculatorsReview }

const RESOLVED_FOOTERS = {
  approved: { text: '✓ This approval was accepted and the workflow continued.', className: 'text-green-300' },
  superseded: { text: '↺ This was replaced by a newer version below.', className: 'text-slate-400' },
  cancelled: { text: 'Отменено: согласование закрыто без решения.', className: 'text-slate-400' },
}
const REJECTED_FOOTER = { text: '✗ This approval was rejected.', className: 'text-red-300' }

export default function ApprovalCardV2({ 
  message, 
  onApprove, 
  onReject, 
  projectId,
  reqAnswers = {},
  setReqAnswers,
  refetchMessages
}) {
  const status = message.status || 'pending'
  const subtype = message.subtype || 'unknown'
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  const Icon = config.icon

  const kind = reviewKind(message.data)
  if (kind) {
    const Review = REVIEWS[kind]
    return <Review key={JSON.stringify([message.status, message.data])} projectId={projectId} message={message} refetchMessages={refetchMessages}/>
  }

  const gateNodeId = message.data?.gate_node_id || ''
  if (gateNodeId.startsWith('hitl_') && status === 'pending') {
    return (
      <HitlCard
        message={message}
        projectId={projectId}
        refetchMessages={refetchMessages}
      />
    )
  }

  const getHeaderText = () => {
    const typeLabel = subtype.charAt(0).toUpperCase() + subtype.slice(1)
    if (status === 'approved') return `✓ Approved: ${typeLabel}`
    if (status === 'rejected') return `✗ Rejected: ${typeLabel}`
    if (status === 'superseded') return `↺ Superseded: ${typeLabel}`
    if (status === 'cancelled') return `Отменено: ${typeLabel}`
    return `Approval Required: ${typeLabel}`
  }

  const handleApprove = async () => {
    try {
      // If requirements with answers, submit them first
      if (subtype === 'requirements' && reqAnswers && Object.keys(reqAnswers).length > 0) {
        const answersText = Object.entries(reqAnswers)
          .map(([q, a]) => `- ${q}: ${a}`)
          .join('\n')
        
        await apiFetch(`/projects/${projectId}/refine/requirements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedback: `User answers to requirements questions:\n${answersText}`,
            current_data: message.data,
            answers: reqAnswers
          })
        })
      }
    } catch (e) {
      console.warn('Refine submit error:', e)
    } finally {
      if (onApprove) {
        await onApprove(message)
      }
      if (refetchMessages) {
        refetchMessages()
      }
    }
  }

  const handleReject = async () => {
    if (onReject) {
      await onReject(message)
    }
    if (refetchMessages) {
      refetchMessages()
    }
  }

  return (
    <div className={`rounded-xl p-6 border ${config.bgClass}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-5 h-5 ${config.iconClass}`} />
        <h3 className={`text-base font-semibold ${config.headerClass}`}>
          {getHeaderText()}
        </h3>
      </div>

      {/* Description */}
      {message.content && (
        <p className="text-sm text-slate-300 mb-4">
          {message.content}
        </p>
      )}

      {/* Data Display */}
      {message.data && (
        <div className="mb-4">
          {(() => {
            // Dispatch on the workflow node id, not on the subtype string.
            // `subtype` carries the human gate_label ("Review output") which is
            // workflow-author-controlled and locale-variable; `gate_node_id` is
            // the stable identifier the workflow engine attaches to every
            // approval payload. Specialised renderers (plan/output/deploy) take
            // priority for the gates that have one.
            const Renderer = GATE_RENDERERS[(message.data.gate_node_id || '').toString().toLowerCase()]
            if (Renderer) {
              return (
                <Renderer
                  data={message.data}
                  answers={reqAnswers}
                  onAnswersChanged={setReqAnswers}
                />
              )
            }
            // Persistent phase gates without a specialised renderer (e.g.
            // gate_req) emit the typed agent_result_review contract
            // (workflow_engine.build_approval_data) with the reviewed payload
            // under data.agent_result.output. Render that instead of dropping
            // to the raw JSON disclosure — gate_req previously resolved to
            // RequirementsDisplay, which reads the now-absent top-level
            // data.requirements (it moved under data.context_snapshot) and so
            // showed an empty "No requirements data available" card over a
            // payload that was actually present.
            if (message.data.interaction_schema?.type === 'agent_result_review' && message.data.agent_result) {
              return <AgentResultDisplay data={message.data} />
            }
            return (
              <details>
                <summary className="cursor-pointer text-sm text-blue-400 hover:text-blue-300 mb-2">
                  View {subtype} data
                </summary>
                <pre className="text-xs bg-slate-900 text-slate-300 p-4 rounded-lg overflow-auto max-h-64 border border-slate-700">
                  {JSON.stringify(message.data, null, 2)}
                </pre>
              </details>
            )
          })()}
        </div>
      )}

      {/* Actions for pending */}
      {status === 'pending' && (
        <div className={`flex gap-3 pt-4 border-t ${config.borderClass}`}>
          <button
            onClick={handleApprove}
            className="flex-1 inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors"
          >
            <CheckCircle className="w-4 h-4" />
            Approve & Continue
          </button>
          <button
            onClick={handleReject}
            className="inline-flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-300 px-4 py-2.5 rounded-lg font-medium transition-colors"
          >
            <XCircle className="w-4 h-4" />
            Reject
          </button>
        </div>
      )}

      {/* Status footer for resolved */}
      {status !== 'pending' && (
        <div className={`pt-4 border-t ${config.borderClass}`}>
          <p className={`text-sm font-medium ${(RESOLVED_FOOTERS[status] || REJECTED_FOOTER).className}`}>
            {(RESOLVED_FOOTERS[status] || REJECTED_FOOTER).text}
          </p>
        </div>
      )}
    </div>
  )
}
