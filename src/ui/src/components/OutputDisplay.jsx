import { useMemo, useState, useCallback } from 'react'
import { Download, Clipboard } from 'lucide-react'
import { notify } from '../utils_notify'
import { basename, monacoLanguage, toDisplayText } from '../utils/filePreview'
import Editor from '@monaco-editor/react'

export default function OutputDisplay({ data }) {
  // Approval gate payloads (workflow_engine._handle_approval_gate) nest the
  // file list under `data.context_snapshot.artifacts`. Older / direct callers
  // pass `data.artifacts`. Accept either so we don't render an empty card
  // when the data is actually present.
  const artifacts = Array.isArray(data?.artifacts)
    ? data.artifacts
    : Array.isArray(data?.context_snapshot?.artifacts)
      ? data.context_snapshot.artifacts
      : []
  const items = useMemo(() => {
    return artifacts.map((a, idx) => ({
      key: `${a.path || 'artifact'}-${idx}`,
      path: a.path || `artifact-${idx}.txt`,
      content: toDisplayText(a.content),
      type: a.type || guessType(a.path),
      timestamp: a.timestamp || a.created_at || ''
    }))
  }, [artifacts])

  const [active, setActive] = useState(items[0]?.key)
  const activeItem = useMemo(() => items.find(i => i.key === active) || items[0], [items, active])

  const copyActive = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(activeItem?.content || '')
      notify({ title: 'Copied', message: 'Content copied to clipboard', variant: 'success', ttl: 2500 })
    } catch (e) {
      notify({ title: 'Copy failed', message: String(e), variant: 'error', ttl: 6000 })
    }
  }, [activeItem])

  const downloadActive = useCallback(() => {
    try {
      const name = basename(activeItem?.path) || 'artifact.txt'
      const blob = new Blob([activeItem?.content || ''], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      notify({ title: 'Download failed', message: String(e), variant: 'error', ttl: 6000 })
    }
  }, [activeItem])

  if (!items.length) {
    return (
      <div className="bg-slate-900 rounded-lg border border-slate-700 p-4 text-slate-300">
        No artifacts to preview.
      </div>
    )
  }

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
      {/* Header: summary */}
      <div className="px-3 py-2 text-xs text-slate-400 border-b border-slate-700 flex items-center justify-between">
        <div>
          {items.length} file{items.length !== 1 ? 's' : ''}
          {data?.execution_result && (
            <span className="ml-2 text-slate-500">• execution result captured</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={copyActive} className="inline-flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-white text-xs px-2 py-1 rounded">
            <Clipboard className="w-3 h-3" /> Copy
          </button>
          <button onClick={downloadActive} className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded">
            <Download className="w-3 h-3" /> Download
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-2 pt-2 overflow-x-auto border-b border-slate-800">
        <div className="flex gap-1 min-w-max">
          {items.map(it => (
            <button
              key={it.key}
              onClick={() => setActive(it.key)}
              className={`px-3 py-1.5 text-xs rounded-t-md border-b-2 transition-colors ${
                active === it.key
                  ? 'text-slate-100 border-blue-500 bg-slate-800'
                  : 'text-slate-400 border-transparent hover:text-slate-200 hover:bg-slate-800/60'
              }`}
              title={it.path}
            >
              {basename(it.path)}
            </button>
          ))}
        </div>
      </div>

      {/* Path label */}
      <div className="px-3 py-1 text-[11px] text-slate-500 border-b border-slate-800 font-mono truncate">
        {activeItem?.path}
      </div>

      {/* Monaco Editor */}
      <div className="h-[460px]">
        <Editor
          language={monacoLanguage(activeItem?.path)}
          theme="vs-dark"
          value={activeItem?.content || ''}
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
    </div>
  )
}

function guessType(p) {
  const ext = (p || '').toLowerCase().split('.').pop()
  return ext || 'text'
}
