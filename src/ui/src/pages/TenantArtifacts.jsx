import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Eye, FileText, FolderOpen, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react'

import FilePreview from '../components/FilePreview'
import TopNavLinks from '../components/TopNavLinks'
import { useAuth } from '../hooks/useAuth.jsx'
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_FILE_ACCEPT,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  formatAttachmentBytes,
  mergeAttachmentFiles,
} from '../utils/attachmentFiles'
import { isPreviewable } from '../utils/filePreview'
import { apiFetch, openPresignedDownload } from '../utils_api'
import { notify } from '../utils_notify'

const ALLOWED_HINT = ALLOWED_ATTACHMENT_EXTENSIONS.map((e) => e.replace('.', '')).join(', ')
const SIZE_HINT = formatAttachmentBytes(DEFAULT_MAX_ATTACHMENT_BYTES)
const REJECT_HINT = `Allowed types: ${ALLOWED_HINT}, up to ${SIZE_HINT}.`
const INPUT_CLASS =
  'w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500'
const LABEL_CLASS = 'block text-xs text-slate-400 mb-1'

function TextField({ id, label, value, onChange, placeholder, disabled }) {
  return (
    <div>
      <label className={LABEL_CLASS} htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    </div>
  )
}

async function downloadWithAuth(downloadUrl, notifyFn) {
  if (!downloadUrl) return
  try {
    await openPresignedDownload(downloadUrl)
  } catch (err) {
    console.error('Download failed:', err)
    notifyFn({
      title: 'Download failed',
      message: String(err).slice(0, 300),
      variant: 'error',
      ttl: 6000,
    })
  }
}

/** Click-or-drop picker. `multiple` is the create dropzone; compact stays one-file replace. */
function FilePicker({ file, files, onPick, disabled, label, compact = false, multiple = false }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const selected = multiple ? (files || []) : (file ? [file] : [])

  const pick = (incoming) => {
    const list = Array.from(incoming || []).filter(Boolean)
    if (!list.length) return
    const { files: merged, rejected } = mergeAttachmentFiles(multiple ? selected : [], list)
    if (rejected.length) {
      notify({ title: 'File rejected', message: REJECT_HINT, variant: 'error', ttl: 6000 })
    }
    if (!multiple) {
      if (merged[0]) onPick(merged[0])
      return
    }
    onPick(merged)
  }
  const open = () => {
    if (!disabled) inputRef.current?.click()
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (!disabled) pick(e.dataTransfer.files)
      }}
      className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed text-center transition-colors focus:outline-none focus:border-blue-500 ${
        compact ? 'min-h-[68px] px-4 py-3' : 'min-h-[132px] px-6 py-6'
      } ${
        disabled
          ? 'border-slate-700 bg-slate-900/40 cursor-not-allowed'
          : dragOver
            ? 'border-blue-400 bg-blue-950/25 cursor-pointer'
            : selected.length
              ? 'border-emerald-600/60 bg-emerald-950/10 hover:border-emerald-500 cursor-pointer'
              : 'border-slate-600 bg-slate-900/50 hover:border-blue-500/60 cursor-pointer'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ATTACHMENT_FILE_ACCEPT}
        multiple={multiple}
        tabIndex={-1}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files)
          e.target.value = ''
        }}
      />
      {selected.length && !multiple ? (
        <>
          <FileText className={compact ? 'w-4 h-4 text-emerald-400/90' : 'w-7 h-7 text-emerald-400/90'} />
          <p className="mt-1 text-sm text-slate-100 font-mono break-all">{selected[0].name}</p>
          <p className="text-xs text-slate-400">{formatAttachmentBytes(selected[0].size)}, click to replace</p>
        </>
      ) : (
        <>
          {!compact && (
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-slate-800 border border-slate-600">
              <Upload className="w-5 h-5 text-slate-400" />
            </div>
          )}
          <p className="text-sm text-slate-200">{compact ? 'Drop a replacement file' : 'Drop files here'}</p>
          <p className="text-xs text-slate-500">or click to browse</p>
        </>
      )}
    </div>
  )
}

function ArtifactCard({ artifact, saving, onSaveMeta, onReplace, onDelete, onView }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState(null)

  const openEditor = () => {
    setTitle(artifact.title || '')
    setDescription(artifact.description == null ? '' : String(artifact.description))
    setFile(null)
    setEditing(true)
  }

  const savingMeta = !!saving[`meta:${artifact.id}`]
  const savingFile = !!saving[`replace:${artifact.id}`]
  const deleting = !!saving[`del:${artifact.id}`]
  const viewable = isPreviewable(artifact.filename)

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {viewable ? (
            <button
              onClick={() => onView(artifact)}
              className="text-sm font-semibold text-slate-100 break-words text-left hover:text-blue-300 hover:underline"
              title={`View ${artifact.filename}`}
            >
              {artifact.title || artifact.filename}
            </button>
          ) : (
            <div className="text-sm font-semibold text-slate-100 break-words">
              {artifact.title || artifact.filename}
            </div>
          )}
          <div className="text-xs text-slate-400 mt-1 break-all font-mono">
            {artifact.filename}
            {artifact.size_bytes != null && (
              <span className="font-sans"> ({formatAttachmentBytes(artifact.size_bytes)})</span>
            )}
          </div>
          {artifact.description ? (
            <div className="text-xs text-slate-300 mt-2 break-words line-clamp-2">{artifact.description}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {viewable && (
            <button
              onClick={() => onView(artifact)}
              title={`View ${artifact.filename}`}
              className="text-xs px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded flex items-center gap-1.5"
            >
              <Eye className="w-3.5 h-3.5" />
              View
            </button>
          )}
          <button
            onClick={() => downloadWithAuth(artifact.download_url, notify)}
            title="Download"
            className="text-xs px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
          <button
            onClick={() => (editing ? setEditing(false) : openEditor())}
            aria-expanded={editing}
            className="text-xs px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1.5"
          >
            {editing ? <X className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
            {editing ? 'Close' : 'Edit'}
          </button>
          <button
            onClick={() => onDelete(artifact.id)}
            disabled={deleting}
            title="Delete"
            className="text-xs px-2.5 py-2 bg-red-600/90 hover:bg-red-700 disabled:bg-slate-700 rounded"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-4 pt-4 border-t border-slate-700 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField
              id={`title-${artifact.id}`}
              label="Title"
              value={title}
              onChange={setTitle}
              placeholder={artifact.filename}
              disabled={savingMeta}
            />
            <TextField
              id={`desc-${artifact.id}`}
              label="Description"
              value={description}
              onChange={setDescription}
              placeholder="What agents should use this for"
              disabled={savingMeta}
            />
          </div>
          <button
            onClick={async () => {
              if (await onSaveMeta(artifact.id, { title, description })) setEditing(false)
            }}
            disabled={savingMeta}
            className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 rounded"
          >
            {savingMeta ? 'Saving...' : 'Save details'}
          </button>

          <div className="pt-3 border-t border-slate-700/70">
            <div className={LABEL_CLASS}>Replace file</div>
            <FilePicker
              compact
              file={file}
              onPick={setFile}
              disabled={savingFile}
              label={`Choose a replacement file for ${artifact.filename}`}
            />
            <button
              onClick={async () => {
                if (await onReplace(artifact.id, file)) setEditing(false)
              }}
              disabled={!file || savingFile}
              className="mt-2 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded"
            >
              {savingFile ? 'Replacing...' : 'Replace'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function TenantArtifacts() {
  const { user } = useAuth()
  const tenantId = user?.tenant_id || ''

  const [artifacts, setArtifacts] = useState([])
  const [listTruncated, setListTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [saving, setSaving] = useState({})
  const [previewing, setPreviewing] = useState(null)

  const [createFiles, setCreateFiles] = useState([])

  const fetchArtifacts = useCallback(async () => {
    if (!tenantId) {
      setError('Your account is not bound to a tenant.')
      setArtifacts([])
      setListTruncated(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/tenants/${tenantId}/artifacts`)
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to load tenant artifacts')
      }
      const data = await res.json()
      setArtifacts(data.artifacts || [])
      setListTruncated(Boolean(data.truncated))
    } catch (err) {
      setError(err.message || 'Failed to load tenant artifacts')
      setListTruncated(false)
    } finally {
      setLoading(false)
    }
  }, [tenantId, refreshTick])

  useEffect(() => {
    fetchArtifacts()
  }, [fetchArtifacts])

  /** Runs one mutation with a busy flag, toast on both paths, list refresh on success. */
  const runMutation = async (key, request, labels) => {
    setSaving((prev) => ({ ...prev, [key]: true }))
    try {
      const res = await request()
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || labels.failure)
      }
      notify({ title: labels.successTitle, message: labels.success, variant: 'success', ttl: 2500 })
      setRefreshTick((t) => t + 1)
      return true
    } catch (err) {
      notify({ title: labels.failure, message: String(err).slice(0, 300), variant: 'error', ttl: 6000 })
      return false
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }))
    }
  }

  const createArtifact = async () => {
    if (!tenantId || !createFiles.length) return
    const fd = new FormData()
    createFiles.forEach((file) => fd.append('files', file, file.name))

    const n = createFiles.length
    const ok = await runMutation(
      'create',
      () => apiFetch(`/tenants/${tenantId}/artifacts`, { method: 'POST', body: fd }),
      {
        successTitle: 'Uploaded',
        success: n === 1 ? 'Tenant artifact created.' : `${n} tenant artifacts created.`,
        failure: 'Upload failed',
      }
    )
    if (ok) setCreateFiles([])
  }

  const saveMeta = (artifactId, draft) =>
    runMutation(
      `meta:${artifactId}`,
      () =>
        apiFetch(`/tenants/${tenantId}/artifacts/${artifactId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: draft.title.trim() ? draft.title.trim() : null,
            description: draft.description.trim() ? draft.description.trim() : null,
          }),
        }),
      { successTitle: 'Saved', success: 'Artifact details updated.', failure: 'Save failed' }
    )

  const replaceFile = (artifactId, file) => {
    if (!file) return Promise.resolve(false)
    const fd = new FormData()
    fd.append('files', file, file.name)
    return runMutation(
      `replace:${artifactId}`,
      () => apiFetch(`/tenants/${tenantId}/artifacts/${artifactId}`, { method: 'PATCH', body: fd }),
      { successTitle: 'Replaced', success: 'Artifact file replaced.', failure: 'Replace failed' }
    )
  }

  const deleteArtifact = (artifactId) => {
    if (!confirm('Delete this tenant artifact? Agents will no longer be able to read it.')) return
    return runMutation(
      `del:${artifactId}`,
      () => apiFetch(`/tenants/${tenantId}/artifacts/${artifactId}`, { method: 'DELETE' }),
      { successTitle: 'Deleted', success: 'Artifact deleted.', failure: 'Delete failed' }
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">Tenant Artifacts</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FolderOpen className="w-5 h-5" />
            Tenant Artifacts
          </h1>
          <button
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={loading}
            className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        <p className="text-sm text-slate-400 leading-relaxed mb-2">
          A shared cabinet for the whole tenant: upload a reference document once and every project in this tenant
          can use it. Agents discover these files with <code className="text-slate-300">tenant_artifact_list</code> and
          read them with <code className="text-slate-300">tenant_artifact_fetch</code>. Unlike project chat
          attachments, nothing here is private to a single project. Use <span className="text-slate-300">View</span> to
          read a file in place: text opens in a read-only editor, images render inline.
        </p>
        <p className="text-xs text-slate-500 mb-4">
          Allowed types: {ALLOWED_HINT}. Up to {SIZE_HINT} per file. Tenant ID:{' '}
          <span className="font-mono text-slate-400">{tenantId || 'N/A'}</span>
        </p>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">
            {error}
          </div>
        )}
        {loading && <div className="text-slate-400 text-sm">Loading...</div>}

        {!loading && !error && (
          <>
            <section className="bg-slate-800 border border-slate-700 rounded-lg p-4 mb-6">
              <h2 className="text-sm font-semibold text-slate-200 mb-3">Upload artifacts</h2>
              <div className="space-y-3">
                <FilePicker
                  multiple
                  files={createFiles}
                  onPick={setCreateFiles}
                  disabled={!!saving.create}
                  label="Choose files to upload"
                />
                {createFiles.length > 0 && (
                  <ul className="space-y-1">
                    {createFiles.map((file, index) => (
                      <li
                        key={`${file.name}:${file.size}:${file.lastModified}`}
                        className="flex items-center justify-between gap-2 text-xs text-slate-300 font-mono bg-slate-900/60 border border-slate-700 rounded px-2 py-1.5"
                      >
                        <span className="truncate">
                          {file.name}
                          <span className="font-sans text-slate-500"> ({formatAttachmentBytes(file.size)})</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setCreateFiles((prev) => prev.filter((_, i) => i !== index))}
                          className="shrink-0 text-slate-500 hover:text-slate-200"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  onClick={createArtifact}
                  disabled={!createFiles.length || !!saving.create}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:text-slate-400 rounded"
                >
                  <Upload className="w-4 h-4" />
                  {saving.create
                    ? 'Uploading...'
                    : createFiles.length > 1
                      ? `Upload ${createFiles.length} files`
                      : 'Upload'}
                </button>
              </div>
            </section>

            <h2 className="text-sm font-semibold text-slate-200 mb-3">
              Shared files
              {artifacts.length > 0 && <span className="text-slate-500 font-normal"> ({artifacts.length})</span>}
            </h2>

            {listTruncated && (
              <p className="text-sm text-amber-300/90 mb-3">
                List truncated to the newest files. Older shared artifacts still exist in storage.
              </p>
            )}

            {artifacts.length === 0 ? (
              <div className="bg-slate-800/60 border border-dashed border-slate-700 rounded-lg px-4 py-8 text-center">
                <FileText className="w-7 h-7 text-slate-600 mx-auto" />
                <p className="text-sm text-slate-300 mt-3">No shared files yet</p>
                <p className="text-xs text-slate-500 mt-1">
                  Use the upload panel above to add the first document your agents can read.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {artifacts.map((a) => (
                  <ArtifactCard
                    key={a.id}
                    artifact={a}
                    saving={saving}
                    onSaveMeta={saveMeta}
                    onReplace={replaceFile}
                    onDelete={deleteArtifact}
                    onView={setPreviewing}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {previewing && (
        <FilePreview
          filename={previewing.filename}
          previewUrl={previewing.preview_url}
          downloadUrl={previewing.download_url}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  )
}
