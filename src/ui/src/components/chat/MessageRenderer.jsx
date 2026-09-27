/**
 * MessageRenderer Component
 * 
 * Renders messages based on their type. This is the central component
 * for the unified message system - it simply switches on message.type
 * and delegates to the appropriate component.
 */

import UserMessage from './UserMessage'
import AssistantMessage from './AssistantMessage'
import ApprovalCardV2 from './ApprovalCardV2'
import SystemMessage from './SystemMessage'
import EventMessage from './EventMessage'
import ThoughtMessage from './ThoughtMessage'
import ToolCallMessage from './ToolCallMessage'
import AskHumanCard from './AskHumanCard'
import A2AInputRequiredCard from './A2AInputRequiredCard'

/**
 * Renders a message based on its type.
 * 
 * @param {Object} props
 * @param {Object} props.message - The message object from the unified message system
 * @param {Function} props.onApprove - Callback when approval is approved
 * @param {Function} props.onReject - Callback when approval is rejected
 * @param {string} props.projectId - Project ID
 * @param {Object} props.reqAnswers - Requirement answers (for requirements approval)
 * @param {Function} props.setReqAnswers - Setter for requirement answers
 * @param {Function} props.onRevert - Callback for revert action
 * @param {Object} props.toolJournal - buildToolJournalIndex output pairing
 *   tool_call messages with their tool_result (built at the list level —
 *   pairing needs the whole stream, one message isn't enough)
 */
export default function MessageRenderer({
  message,
  onApprove,
  onReject,
  projectId,
  reqAnswers,
  setReqAnswers,
  onRevert,
  refetchMessages,
  toolJournal
}) {
  if (!message) return null

  switch (message.type) {
    case 'user':
      return (
        <UserMessage 
          message={message} 
          onRevert={onRevert}
        />
      )
    
    case 'assistant':
      return <AssistantMessage message={message} projectId={projectId} />
    
    case 'approval':
      return (
        <ApprovalCardV2
          message={message}
          onApprove={onApprove}
          onReject={onReject}
          projectId={projectId}
          reqAnswers={reqAnswers}
          setReqAnswers={setReqAnswers}
          refetchMessages={refetchMessages}
        />
      )
    
    case 'system':
      return <SystemMessage message={message} />
    
    case 'event':
      return <EventMessage message={message} />
    
    case 'thought':
      return <ThoughtMessage message={message} />

    case 'tool_call':
      // An ask_human call is a question to the user, not a tool line: while
      // its result is missing, the card offers an answer box (ADR-0010).
      if (message.data?.name === 'ask_human') {
        return (
          <AskHumanCard
            call={message}
            result={toolJournal?.resultByCallMsgId?.get(message.id)}
            projectId={projectId}
          />
        )
      }
      // An a2a_human_input call is the input-required bridge's question
      // (AppFactory-281) — same journal shape, different subsystem and answer
      // route (see A2AInputRequiredCard's own docstring).
      if (message.data?.name === 'a2a_human_input') {
        return (
          <A2AInputRequiredCard
            call={message}
            result={toolJournal?.resultByCallMsgId?.get(message.id)}
            projectId={projectId}
          />
        )
      }
      return (
        <ToolCallMessage
          call={message}
          result={toolJournal?.resultByCallMsgId?.get(message.id)}
        />
      )

    case 'tool_result':
      // A paired result already renders inside its call's card, and a
      // duplicate of an in-window closed call is suppressed; only a result
      // whose call fell outside the fetched window stands alone.
      if (toolJournal?.pairedResultIds?.has(message.id)) return null
      return <ToolCallMessage result={message} />

    default:
      console.warn('Unknown message type:', message.type)
      return (
        <div className="text-xs text-slate-500 p-2">
          Unknown message type: {message.type}
        </div>
      )
  }
}
