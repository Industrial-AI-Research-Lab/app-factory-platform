import { useEffect, useState } from 'react'
import { FileText, File as FileIcon, Image as ImageIcon, X } from 'lucide-react'
import { formatAttachmentBytes, isImageAttachment, isImageMime } from '../../utils/attachmentFiles'

function pickIcon({ file, mime, imageUrl }) {
  if (imageUrl || (file && isImageAttachment(file)) || isImageMime(mime)) {
    return ImageIcon
  }
  const name = (file?.name || '').toLowerCase()
  if (/\.(txt|md|json|yaml|yml|csv|py|js|ts|html|css|xml)$/.test(name)) {
    return FileText
  }
  return FileIcon
}

export default function AttachmentFileChip({
  file,
  label,
  sizeBytes,
  mime,
  imageUrl,
  onRemove,
  onClick,
  compact = false,
}) {
  const name = label || file?.name || 'file'
  const size = sizeBytes != null ? formatAttachmentBytes(sizeBytes) : file ? formatAttachmentBytes(file.size) : ''
  const Icon = pickIcon({ file, mime, imageUrl })
  const [localThumb, setLocalThumb] = useState(null)
  useEffect(() => {
    if (imageUrl) {
      setLocalThumb(imageUrl)
      return undefined
    }
    if (file && isImageAttachment(file)) {
      const url = URL.createObjectURL(file)
      setLocalThumb(url)
      return () => URL.revokeObjectURL(url)
    }
    setLocalThumb(null)
    return undefined
  }, [file, imageUrl])
  const thumb = localThumb

  const body = (
    <>
      <div className="flex-shrink-0 w-8 h-8 rounded-md bg-slate-800 border border-slate-600/80 overflow-hidden flex items-center justify-center">
        {thumb ? (
          <img src={thumb} alt="" className="w-full h-full object-cover" />
        ) : (
          <Icon className="w-4 h-4 text-slate-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-slate-100 truncate max-w-[180px]">{name}</div>
        {!compact && (size || mime) && (
          <div className="text-[10px] text-slate-500 truncate">
            {size}
            {mime ? (size ? ` · ${mime}` : mime) : ''}
          </div>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="flex-shrink-0 p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-700/80 transition-colors"
          aria-label={`Remove ${name}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </>
  )

  const className =
    'inline-flex items-center gap-2 max-w-[240px] px-2 py-1.5 rounded-xl bg-slate-800/90 border border-slate-600/70 hover:border-slate-500/80 transition-colors'

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} text-left`}>
        {body}
      </button>
    )
  }

  return <div className={className}>{body}</div>
}
