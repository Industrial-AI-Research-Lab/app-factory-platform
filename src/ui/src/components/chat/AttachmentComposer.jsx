import { useCallback, useRef, useState } from 'react'
import { Loader, Paperclip, Send, XCircle } from 'lucide-react'
import { notify } from '../../utils_notify'
import {
  ATTACHMENT_FILE_ACCEPT,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENT_FILES,
  mergeAttachmentFiles,
} from '../../utils/attachmentFiles'
import AttachmentFileChip from './AttachmentFileChip'

/**
 * Modern chat composer with inline attachment chips (DeepSeek / Qwen style).
 */
export default function AttachmentComposer({
  value,
  onChange,
  files = [],
  onFilesChange,
  onSubmit,
  placeholder = 'Send a message...',
  disabled = false,
  submitDisabled = false,
  loading = false,
  submitOnEnter = true,
  minRows = 1,
  maxFiles = DEFAULT_MAX_ATTACHMENT_FILES,
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  variant = 'chat',
  submitMode = 'send',
  footer = null,
  className = '',
}) {
  const fileInputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const addFiles = useCallback(
    (incoming) => {
      if (!incoming?.length || disabled) return
      const { files: merged, rejected } = mergeAttachmentFiles(files, incoming, { maxFiles, maxBytes })
      if (rejected.length) {
        const reason = rejected[0].reason
        notify({
          title: 'Cannot attach file',
          message:
            reason === 'max_files'
              ? `Maximum ${maxFiles} files per message.`
              : reason === 'file_type'
                ? 'Allowed types: pdf, docx, xlsx, txt, md, py, png, jpg.'
                : `Each file must be under ${Math.round(maxBytes / (1024 * 1024))} MB.`,
          variant: 'error',
          ttl: 5000,
        })
      }
      if (merged.length !== files.length) onFilesChange?.(merged)
    },
    [disabled, files, maxBytes, maxFiles, onFilesChange],
  )

  const removeFile = (index) => {
    onFilesChange?.(files.filter((_, i) => i !== index))
  }

  const onKeyDown = (e) => {
    if (!submitOnEnter || e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    if (!submitDisabled && !disabled && !loading) onSubmit?.()
  }

  const onPickFiles = (e) => {
    addFiles(Array.from(e.target.files || []))
    e.target.value = ''
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (disabled) return
    addFiles(Array.from(e.dataTransfer.files || []))
  }

  const isHome = variant === 'home'
  const shellClass = isHome
    ? 'rounded-lg border border-slate-600 bg-slate-700 focus-within:ring-2 focus-within:ring-blue-500'
    : 'rounded-2xl border border-slate-600/80 bg-slate-800 shadow-lg focus-within:border-blue-500/60 focus-within:ring-2 focus-within:ring-blue-500/30'

  const SubmitIcon = submitMode === 'interrupt' ? XCircle : Send
  const submitClass =
    submitMode === 'interrupt'
      ? 'bg-red-600 hover:bg-red-700 disabled:bg-slate-700'
      : 'bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700'

  return (
    <div className={className}>
      <div
        className={`relative transition-colors ${shellClass} ${dragOver ? 'border-blue-400/70 bg-slate-800/90' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
        }}
        onDrop={onDrop}
      >
        {dragOver && !disabled && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-blue-500/10 border-2 border-dashed border-blue-400/50">
            <span className="text-sm text-blue-200">Drop files to attach</span>
          </div>
        )}

        {files.length > 0 && (
          <div className={`flex flex-wrap gap-2 px-3 pt-3 ${isHome ? 'pb-1' : 'pb-2'}`}>
            {files.map((file, index) => (
              <AttachmentFileChip
                key={`${file.name}-${file.size}-${file.lastModified}`}
                file={file}
                onRemove={() => removeFile(index)}
                compact={isHome}
              />
            ))}
          </div>
        )}

        <textarea
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={minRows}
          disabled={disabled}
          className={`w-full resize-none bg-transparent text-slate-100 placeholder:text-slate-500 focus:outline-none ${
            isHome ? 'px-4 py-3 text-base min-h-[8rem]' : 'px-4 py-3 text-base min-h-[52px] max-h-[200px]'
          }`}
        />

        <div className={`flex items-center justify-between gap-2 px-2 pb-2 ${isHome ? 'pt-0' : ''}`}>
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_FILE_ACCEPT}
              className="hidden"
              disabled={disabled}
              onChange={onPickFiles}
            />
            <button
              type="button"
              disabled={disabled || files.length >= maxFiles}
              onClick={() => fileInputRef.current?.click()}
              title="Attach files"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Paperclip className="w-5 h-5" />
            </button>
            <span className="hidden sm:inline text-[11px] text-slate-600">
              Up to {maxFiles} files · {Math.round(maxBytes / (1024 * 1024))} MB each
            </span>
          </div>

          {!isHome && (
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitDisabled || disabled || loading}
              title={submitMode === 'interrupt' ? 'Stop, revert, and send' : 'Send message'}
              className={`${submitClass} disabled:cursor-not-allowed text-white w-10 h-10 rounded-xl transition-colors flex items-center justify-center flex-shrink-0`}
            >
              {loading ? <Loader className="w-4 h-4 animate-spin" /> : <SubmitIcon className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>

      {footer}
    </div>
  )
}
