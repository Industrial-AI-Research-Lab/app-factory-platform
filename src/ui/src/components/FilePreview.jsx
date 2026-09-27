import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import { Clipboard, Download, FileText, X } from 'lucide-react'

import { openPresignedDownload, presignedDownloadUrl } from '../utils_api'
import { notify } from '../utils_notify'
import { basename, fetchPreviewText, monacoLanguage, previewKind, toDisplayText } from '../utils/filePreview'

// Start the Monaco AMD bundle while the page is idle so the first View is not a
// full editor download. Ceiling: still one Hetzner GET per text/office file.
loader.init()

const NO_PREVIEW_NOTE = {
  pdf: 'PDF cannot be shown here (the file is stored for download). Use Download to open it.',
  unknown: 'No preview is available for this file type. Download it to inspect the contents.',
}

/**
 * Read-only viewer: Monaco for text and Office extracts, img for pictures.
 * PDF stays download-only (S3 objects are stored with Content-Disposition: attachment).
 *
 * Pass `content` for bytes already in the page payload (generated artifacts),
 * or `previewUrl` / `downloadUrl` to load them through the API.
 */
export default function FilePreview({ filename, path, content, previewUrl, downloadUrl, onClose }) {
  const label = basename(path || filename) || 'file'
  const kind = content != null ? 'text' : previewKind(filename || path)
  const [state, setState] = useState({ status: 'loading' })
  const closeRef = useRef(null)

  useEffect(() => {
    let alive = true
    const fail = (err) => {
      if (!alive) return
      const message = String(err?.message || err)
      setState({ status: 'error', error: message })
      notify({ title: 'Preview failed', message: message.slice(0, 300), variant: 'error', ttl: 6000 })
    }

    if (content != null) {
      setState({ status: 'ready', text: toDisplayText(content) })
      return undefined
    }
    setState({ status: 'loading' })
    if (kind === 'text' || kind === 'office') {
      fetchPreviewText(previewUrl)
        .then((data) => alive && setState({ status: 'ready', ...data }))
        .catch(fail)
    } else if (kind === 'image') {
      presignedDownloadUrl(downloadUrl)
        .then((url) => alive && setState({ status: 'ready', imageUrl: url }))
        .catch(fail)
    } else {
      setState({ status: 'ready' })
    }
    return () => {
      alive = false
    }
  }, [content, kind, previewUrl, downloadUrl])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(state.text || '')
      notify({ title: 'Copied', message: `${label} copied to clipboard`, variant: 'success', ttl: 2500 })
    } catch (e) {
      notify({ title: 'Copy failed', message: String(e), variant: 'error', ttl: 6000 })
    }
  }, [state.text, label])

  const download = useCallback(async () => {
    try {
      if (downloadUrl) {
        await openPresignedDownload(downloadUrl)
        return
      }
      const blob = new Blob([state.text || ''], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = label
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      notify({ title: 'Download failed', message: String(e?.message || e), variant: 'error', ttl: 6000 })
    }
  }, [downloadUrl, state.text, label])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${label}`}
        className="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-lg overflow-hidden shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-700">
          <div className="min-w-0 flex items-center gap-2">
            <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <span className="text-sm text-slate-100 font-mono truncate" title={path || filename}>
              {label}
            </span>
            <span className="text-xs text-slate-500 flex-shrink-0">read-only</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {(kind === 'text' || kind === 'office') && state.status === 'ready' && (
              <button
                onClick={copy}
                className="inline-flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-white text-xs px-2 py-1 rounded"
              >
                <Clipboard className="w-3 h-3" /> Copy
              </button>
            )}
            <button
              onClick={download}
              className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded"
            >
              <Download className="w-3 h-3" /> Download
            </button>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close preview"
              className="inline-flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-white text-xs px-2 py-1 rounded"
            >
              <X className="w-3 h-3" /> Close
            </button>
          </div>
        </div>

        {state.extracted && (
          <div className="px-3 py-1.5 text-xs text-slate-300 bg-slate-800 border-b border-slate-700">
            Plain-text extract from Word/Excel. Layout, charts and formatting are omitted.
          </div>
        )}
        {state.truncated && (
          <div className="px-3 py-1.5 text-xs text-amber-200 bg-amber-900/30 border-b border-amber-800/60">
            Showing the first 1 MB only. Download the file for the full contents.
          </div>
        )}

        {state.status === 'loading' && <div className="px-3 py-10 text-sm text-slate-400 text-center">Loading preview...</div>}

        {state.status === 'error' && (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-red-300">{state.error}</p>
            <p className="text-xs text-slate-500 mt-1">You can still download the file.</p>
          </div>
        )}

        {state.status === 'ready' && (kind === 'text' || kind === 'office') && (
          <div className="h-[60vh]">
            <Editor
              language={kind === 'office' ? 'plaintext' : monacoLanguage(path || filename)}
              theme="vs-dark"
              value={state.text || ''}
              options={{
                readOnly: true,
                wordWrap: 'on',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 13,
                renderWhitespace: 'selection',
              }}
            />
          </div>
        )}

        {state.status === 'ready' && kind === 'image' && (
          <div className="max-h-[60vh] overflow-auto bg-slate-950 flex items-center justify-center p-4">
            <img src={state.imageUrl} alt={label} className="max-w-full" />
          </div>
        )}

        {state.status === 'ready' && (kind === 'pdf' || kind === 'unknown') && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-slate-300">{NO_PREVIEW_NOTE[kind] || NO_PREVIEW_NOTE.unknown}</p>
          </div>
        )}
      </div>
    </div>
  )
}
