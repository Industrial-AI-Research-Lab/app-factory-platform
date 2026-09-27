/**
 * UserMessage Component
 *
 * Renders a user message in the chat interface.
 */

import { User, RotateCcw } from 'lucide-react'
import { parseTimestamp } from '../../utils_time'
import { openPresignedDownload } from '../../utils_api'
import { notify } from '../../utils_notify'
import { userMessageAttachmentEntries } from '../../utils/attachmentFiles'
import AttachmentFileChip from './AttachmentFileChip'

export default function UserMessage({ message, onRevert }) {
  const parsed = parseTimestamp(message.created_at)
  const timestamp = parsed ? parsed.toLocaleTimeString() : null
  const attachmentEntries = userMessageAttachmentEntries(message.attachments)

  const downloadWithAuth = async (downloadUrl) => {
    if (!downloadUrl) return
    try {
      await openPresignedDownload(downloadUrl)
    } catch (err) {
      console.error('Download failed:', err)
      notify({ title: 'Download failed', message: String(err).slice(0, 300), variant: 'error', ttl: 6000 })
    }
  }

  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
        <User className="w-4 h-4 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-blue-300">You</span>
          {timestamp && (
            <span className="text-xs text-slate-500">{timestamp}</span>
          )}
          {message.data?.edited && (
            <span className="text-xs text-amber-400">(edited)</span>
          )}
        </div>
        {message.content ? (
          <div className="text-slate-200 whitespace-pre-wrap break-words">
            {message.content}
          </div>
        ) : null}
        {attachmentEntries.length > 0 && (
          <div className={`flex flex-wrap gap-2 ${message.content ? 'mt-3' : ''}`}>
            {attachmentEntries.map((att) => (
              <AttachmentFileChip
                key={att.key}
                label={att.label}
                sizeBytes={att.sizeBytes}
                mime={att.mime}
                onClick={() => downloadWithAuth(att.downloadUrl)}
              />
            ))}
          </div>
        )}
        {onRevert && message.sequence > 1 && (
          <button
            onClick={() => onRevert(message)}
            className="mt-2 text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors"
            title="Revert to this message"
          >
            <RotateCcw className="w-3 h-3" />
            Revert to here
          </button>
        )}
      </div>
    </div>
  )
}
