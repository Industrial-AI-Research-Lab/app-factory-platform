import { Braces } from 'lucide-react'
import { truncatePreviewText } from './previewUtils'

export default function JsonCard({ data }) {
  const preview = truncatePreviewText(JSON.stringify(data, null, 2))

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">Structured JSON</div>
          <div className="text-xs text-slate-400">
            Parsed successfully, but no specialized card matched this payload
          </div>
        </div>
        <Braces className="h-4 w-4 flex-shrink-0 text-slate-400" />
      </div>

      <pre className="max-h-96 overflow-auto rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300">
        {preview.text}
      </pre>
      {preview.isTruncated && (
        <p className="mt-2 text-[11px] text-slate-400">
          Preview truncated to 20,000 characters.
        </p>
      )}
    </div>
  )
}
