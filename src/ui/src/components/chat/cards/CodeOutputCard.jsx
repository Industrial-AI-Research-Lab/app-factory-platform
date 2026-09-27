import { FileCode2 } from 'lucide-react'
import OutputDisplay from '../../OutputDisplay'
import { toArray } from './messageCardUtils'
import { truncatePreviewText } from './previewUtils'

function normalizeArtifacts(data) {
  if (Array.isArray(data?.artifacts) && data.artifacts.length > 0) {
    return data.artifacts
  }

  const files = toArray(data?.files)
  if (files.length > 0) {
    return files.map((file, index) => {
      if (typeof file === 'string') {
        return { path: file, content: '' }
      }

      return {
        path: file?.path || file?.name || `file-${index}.txt`,
        content: file?.content || file?.code || '',
        type: file?.type,
        timestamp: file?.timestamp || file?.created_at,
      }
    })
  }

  if (typeof data?.code === 'string') {
    const language = data?.language || 'txt'
    return [
      {
        path: data?.path || data?.filename || `snippet.${language}`,
        content: data.code,
        type: language,
      },
    ]
  }

  return []
}

export default function CodeOutputCard({ data }) {
  const artifacts = normalizeArtifacts(data).map((artifact) => {
    const preview = truncatePreviewText(artifact?.content)
    return {
      ...artifact,
      content: preview.text,
      preview_truncated: preview.isTruncated,
      preview_original_length: preview.originalLength,
    }
  })
  const hasTruncatedArtifacts = artifacts.some((artifact) => artifact.preview_truncated)

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">Code Output</div>
          <div className="text-xs text-slate-400">
            Generated files and code artifacts
          </div>
        </div>
        <FileCode2 className="h-4 w-4 flex-shrink-0 text-emerald-400" />
      </div>

      <OutputDisplay data={{ ...data, artifacts }} />
      {hasTruncatedArtifacts && (
        <p className="mt-2 text-[11px] text-slate-400">
          Preview truncated to 20,000 characters per artifact.
        </p>
      )}
    </div>
  )
}
