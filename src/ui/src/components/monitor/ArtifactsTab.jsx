import { useState } from 'react'
import {
  Package,
  FileText,
  Download,
  Clipboard,
  Archive,
  Database,
  Eye,
  Folder,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import JSZip from 'jszip'
import { notify } from '../../utils_notify'
import { apiFetch, openPresignedDownload } from '../../utils_api'
import { formatAttachmentBytes, fetchAllProjectUserAttachments } from '../../utils/attachmentFiles'
import { basename, isPreviewable } from '../../utils/filePreview'
import FilePreview from '../FilePreview'
import { addGeneratedArtifactsToZip, archiveRefPath, downloadGeneratedArtifact } from './generatedArtifactFiles'

const USER_ATTACHMENTS_FOLDER = 'user_attachments'
const VIEW_BUTTON_CLASS =
  'inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded flex-shrink-0'
const TOGGLE_CLASS =
  'inline-flex items-center gap-2 text-left min-w-0 rounded hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500'
const FILTER_INPUT_CLASS =
  'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-500'

function nameMatches(haystack, query) {
  if (!query) return true
  return String(haystack || '').toLowerCase().includes(query)
}

function attachmentDisplayName(item) {
  return item.filename || basename(item.path) || item.path || `${USER_ATTACHMENTS_FOLDER}/${item.id}`
}

/** Unique zip entry under user_attachments/, no path traversal via filename. */
function zipAttachmentPath(item, used) {
  const raw = attachmentDisplayName(item).replace(/[/\\]/g, '_') || 'file'
  const dot = raw.lastIndexOf('.')
  const stem = dot > 0 ? raw.slice(0, dot) : raw
  const ext = dot > 0 ? raw.slice(dot) : ''
  let name = raw
  let n = 1
  while (used.has(`${USER_ATTACHMENTS_FOLDER}/${name}`)) {
    name = `${stem}_${n}${ext}`
    n += 1
  }
  const path = `${USER_ATTACHMENTS_FOLDER}/${name}`
  used.add(path)
  return path
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function ArtifactsTab({ project, projectId, archiveRefs = [] }) {
  const artifacts = project?.artifacts || []
  const userAttachments = project?.user_attachments || []
  const userAttachmentsTruncated = Boolean(project?.user_attachments_truncated)
  const [previewing, setPreviewing] = useState(null)
  // ponytail: Generated open (primary), attachments collapsed so long lists do not own the viewport
  const [generatedOpen, setGeneratedOpen] = useState(true)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [spillsOpen, setSpillsOpen] = useState(false)
  const [nameFilter, setNameFilter] = useState('')
  const [zipping, setZipping] = useState(false)

  const query = nameFilter.trim().toLowerCase()
  const filteredArtifacts = artifacts.filter((a) =>
    nameMatches(a.path, query) || nameMatches(basename(a.path), query)
  )
  const filteredAttachments = userAttachments.filter((item) =>
    nameMatches(attachmentDisplayName(item), query)
  )
  const filteredRefs = archiveRefs.filter((ref) =>
    nameMatches(ref.tool_id, query) || nameMatches(ref.agent_id, query) || nameMatches(ref.ref_id, query)
  )
  // Expand a section when the filter hits files inside a collapsed list.
  const showGenerated = generatedOpen || (query.length > 0 && filteredArtifacts.length > 0)
  const showAttachments = attachmentsOpen || (query.length > 0 && filteredAttachments.length > 0)
  const showSpills = spillsOpen || (query.length > 0 && filteredRefs.length > 0)

  const downloadArtifact = async (artifact) => {
    try {
      await downloadGeneratedArtifact(artifact, projectId, { openDownload: openPresignedDownload, saveBlob })
    } catch (e) {
      notify({ title: 'Download failed', message: String(e?.message || e), variant: 'error', ttl: 6000 })
    }
  }

  const copyArtifact = async (artifact) => {
    try {
      const content = artifact.content ?? JSON.stringify(artifact, null, 2)
      await navigator.clipboard.writeText(content)
      notify({ title: 'Copied', message: 'Artifact content copied to clipboard', variant: 'success', ttl: 2500 })
    } catch (e) {
      console.error('Copy failed:', e)
      notify({ title: 'Copy failed', message: String(e), variant: 'error', ttl: 6000 })
    }
  }

  const downloadUserAttachment = async (item) => {
    try {
      await openPresignedDownload(item.download_url)
    } catch (e) {
      notify({ title: 'Download failed', message: String(e?.message || e), variant: 'error', ttl: 6000 })
    }
  }

  const downloadArchiveRef = async (ref) => {
    try {
      await openPresignedDownload(archiveRefPath(projectId, ref.ref_id, 'download-url'))
    } catch (e) {
      notify({ title: 'Download failed', message: String(e?.message || e), variant: 'error', ttl: 6000 })
    }
  }

  const downloadAllArtifactsAsZip = async () => {
    if (artifacts.length === 0 && userAttachments.length === 0) return
    setZipping(true)
    try {
      const zip = new JSZip()
      await addGeneratedArtifactsToZip(zip, artifacts, projectId, apiFetch)

      const attachmentsForZip = projectId
        ? await fetchAllProjectUserAttachments(projectId, apiFetch)
        : userAttachments

      // Bytes via API (?raw=1), not S3 presign — browser fetch of object storage hits CORS.
      const used = new Set()
      for (const item of attachmentsForZip) {
        if (!item.download_url) continue
        const entry = zipAttachmentPath(item, used)
        const sep = item.download_url.includes('?') ? '&' : '?'
        const res = await apiFetch(`${item.download_url}${sep}raw=1`)
        if (!res.ok) {
          throw new Error(`Failed to fetch ${attachmentDisplayName(item)} (${res.status})`)
        }
        zip.file(entry, await res.arrayBuffer())
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      saveBlob(blob, `${project?.name || 'project'}-artifacts.zip`)
    } catch (error) {
      console.error('Failed to create ZIP:', error)
      notify({ title: 'ZIP failed', message: String(error?.message || error), variant: 'error', ttl: 6000 })
    } finally {
      setZipping(false)
    }
  }

  const sectionCount = (visible, total) =>
    query ? `${visible}/${total}` : String(total)

  if (artifacts.length === 0 && userAttachments.length === 0 && archiveRefs.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg p-8 text-center">
        <Package className="w-12 h-12 text-slate-600 mx-auto mb-3" />
        <p className="text-slate-400">No artifacts generated yet</p>
      </div>
    )
  }

  return (
    <div className="bg-slate-800 rounded-lg p-6 space-y-6">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <label className="block flex-1 min-w-0">
          <span className="sr-only">Filter files by name</span>
          <input
            type="search"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter by name…"
            className={FILTER_INPUT_CLASS}
          />
        </label>
        <button
          type="button"
          onClick={downloadAllArtifactsAsZip}
          disabled={zipping}
          className="inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors flex-shrink-0"
        >
          <Archive className="w-4 h-4" />
          {zipping ? 'Building ZIP…' : 'Download All as ZIP'}
        </button>
      </div>

      {userAttachmentsTruncated && (
        <p className="text-sm text-amber-300/90 px-1">
          User Attachments list shows the newest files only. Download All as ZIP fetches every attachment from the server.
        </p>
      )}

      {artifacts.length > 0 && (
        <div>
          <div className="flex justify-between items-center gap-3 mb-4">
            <button
              type="button"
              onClick={() => setGeneratedOpen((open) => !open)}
              className={TOGGLE_CLASS}
              aria-expanded={showGenerated}
            >
              {showGenerated
                ? <ChevronDown className="w-5 h-5 text-slate-400 flex-shrink-0" />
                : <ChevronRight className="w-5 h-5 text-slate-400 flex-shrink-0" />}
              <h3 className="text-lg font-semibold text-slate-100">
                Generated Artifacts ({sectionCount(filteredArtifacts.length, artifacts.length)})
              </h3>
            </button>
          </div>
          {showGenerated && (
            <div className="space-y-2">
              {filteredArtifacts.length === 0 ? (
                <p className="text-sm text-slate-400 px-1">No generated artifacts match this filter.</p>
              ) : filteredArtifacts.map((artifact, idx) => (
                <div key={idx} className="flex items-center justify-between p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-blue-400" />
                    <div>
                      <p className="text-sm font-medium text-slate-200">{artifact.path}</p>
                      <p className="text-xs text-slate-400">{artifact.type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">{artifact.timestamp || artifact.created_at || ''}</span>
                    {artifact.content != null && (
                      <button
                        onClick={() => setPreviewing({ path: artifact.path, content: artifact.content })}
                        className={VIEW_BUTTON_CLASS}
                      >
                        <Eye className="w-4 h-4" /> View
                      </button>
                    )}
                    <button
                      onClick={() => downloadArtifact(artifact)}
                      className="inline-flex items-center gap-1 bg-slate-600 hover:bg-slate-500 text-white text-xs px-3 py-1.5 rounded"
                    >
                      <Download className="w-4 h-4" /> Download
                    </button>
                    {artifact.content && (
                      <button
                        onClick={() => copyArtifact(artifact)}
                        className="inline-flex items-center gap-1 bg-slate-600 hover:bg-slate-500 text-white text-xs px-3 py-1.5 rounded"
                      >
                        <Clipboard className="w-4 h-4" /> Copy
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {userAttachments.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setAttachmentsOpen((open) => !open)}
            className={`${TOGGLE_CLASS} mb-3`}
            aria-expanded={showAttachments}
          >
            {showAttachments
              ? <ChevronDown className="w-5 h-5 text-amber-400 flex-shrink-0" />
              : <ChevronRight className="w-5 h-5 text-amber-400 flex-shrink-0" />}
            <Folder className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <h3 className="text-lg font-semibold text-slate-100">
              User Attachments ({sectionCount(filteredAttachments.length, userAttachments.length)})
            </h3>
          </button>
          {showAttachments && (
            <div className="space-y-2">
              {filteredAttachments.length === 0 ? (
                <p className="text-sm text-slate-400 px-1">No user attachments match this filter.</p>
              ) : filteredAttachments.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="w-5 h-5 text-amber-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">
                        {attachmentDisplayName(item)}
                      </p>
                      <p className="text-xs text-slate-400">
                        {formatAttachmentBytes(item.size_bytes)}
                        {item.content_type ? ` · ${item.content_type}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {isPreviewable(item.filename) && (
                      <button
                        onClick={() => setPreviewing({
                          filename: item.filename,
                          path: item.path,
                          previewUrl: item.preview_url,
                          downloadUrl: item.download_url,
                        })}
                        className={VIEW_BUTTON_CLASS}
                      >
                        <Eye className="w-4 h-4" /> View
                      </button>
                    )}
                    <button
                      onClick={() => downloadUserAttachment(item)}
                      className="inline-flex items-center gap-1 bg-slate-600 hover:bg-slate-500 text-white text-xs px-3 py-1.5 rounded flex-shrink-0"
                    >
                      <Download className="w-4 h-4" /> Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {archiveRefs.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setSpillsOpen((open) => !open)}
            className={`${TOGGLE_CLASS} mb-3`}
            aria-expanded={showSpills}
          >
            {showSpills
              ? <ChevronDown className="w-5 h-5 text-emerald-400 flex-shrink-0" />
              : <ChevronRight className="w-5 h-5 text-emerald-400 flex-shrink-0" />}
            <Database className="w-5 h-5 text-emerald-400 flex-shrink-0" />
            <h3 className="text-lg font-semibold text-slate-100">
              Large Tool Outputs ({sectionCount(filteredRefs.length, archiveRefs.length)})
            </h3>
          </button>
          {showSpills && (
            <div className="space-y-2">
              {filteredRefs.length === 0 ? (
                <p className="text-sm text-slate-400 px-1">No tool outputs match this filter.</p>
              ) : filteredRefs.map((ref) => {
                const meta = [
                  ref.tool_id ? ref.agent_id : null,
                  formatAttachmentBytes(ref.size_bytes),
                  ref.content_type,
                ].filter(Boolean)
                return (
                  <div
                    key={ref.ref_id}
                    className="flex items-center justify-between gap-3 p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Database className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-200 truncate" title={ref.ref_id}>
                          {ref.tool_id || ref.agent_id || ref.ref_id}
                        </p>
                        {meta.length > 0 && (
                          <p className="text-xs text-slate-400">{meta.join(' · ')}</p>
                        )}
                        {ref.preview && (
                          <p
                            className="text-xs text-slate-500 mt-1 whitespace-pre-wrap break-words line-clamp-2"
                            title={ref.preview}
                          >
                            {ref.preview}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => downloadArchiveRef(ref)}
                        className="inline-flex items-center gap-1 bg-slate-600 hover:bg-slate-500 text-white text-xs px-3 py-1.5 rounded flex-shrink-0"
                      >
                        <Download className="w-4 h-4" /> Download
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {previewing && (
        <FilePreview {...previewing} onClose={() => setPreviewing(null)} />
      )}
    </div>
  )
}
