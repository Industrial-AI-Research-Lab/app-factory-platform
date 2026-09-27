/** Client-side attachment pick limits (mirror backend defaults). */
export const DEFAULT_MAX_ATTACHMENT_FILES = 10
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** Keep in sync with FileAttachmentStore.list_user_attachments max page size. */
export const USER_ATTACHMENT_LIST_PAGE_SIZE = 500

/** Keep in sync with src/storage/file_upload_validation.py ALLOWED_UPLOAD_KINDS. */
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  '.csv',
  '.docx',
  '.html',
  '.jpeg',
  '.jpg',
  '.json',
  '.jsonl',
  '.md',
  '.pdf',
  '.png',
  '.py',
  '.sqlite3',
  '.txt',
  '.xlsx',
]
export const ATTACHMENT_FILE_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.join(',')

const ALLOWED_EXT = new Set(ALLOWED_ATTACHMENT_EXTENSIONS)

export function fileExtension(name) {
  const raw = String(name || '')
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return ''
  return raw.slice(dot).toLowerCase()
}

export function isAllowedAttachmentName(name) {
  return ALLOWED_EXT.has(fileExtension(name))
}

export function formatAttachmentBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let idx = -1
  let v = n
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024
    idx += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[idx]}`
}

export function attachmentFileKey(file) {
  return `${file?.name || ''}:${file?.size || 0}:${file?.lastModified || 0}`
}

/** @returns {{ files: File[], rejected: { file: File, reason: string }[] }} */
export function mergeAttachmentFiles(existing, incoming, limits = {}) {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_ATTACHMENT_FILES
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
  const merged = [...(existing || [])]
  const seen = new Set(merged.map(attachmentFileKey))
  const rejected = []

  for (const file of incoming || []) {
    if (!file) continue
    const key = attachmentFileKey(file)
    if (seen.has(key)) continue
    if (merged.length >= maxFiles) {
      rejected.push({ file, reason: 'max_files' })
      continue
    }
    if (!isAllowedAttachmentName(file.name)) {
      rejected.push({ file, reason: 'file_type' })
      continue
    }
    if (file.size > maxBytes) {
      rejected.push({ file, reason: 'max_size' })
      continue
    }
    merged.push(file)
    seen.add(key)
  }
  return { files: merged, rejected }
}

export function isImageAttachment(file) {
  return Boolean(file?.type && String(file.type).startsWith('image/'))
}

export function isImageMime(mime) {
  return Boolean(mime && String(mime).startsWith('image/'))
}

/** True when chat send is allowed: non-empty text and/or at least one file. */
export function canSendChatPayload(text, files) {
  return Boolean(String(text || '').trim() || (files && files.length > 0))
}

/**
 * Multipart body for POST /projects when the user attached files.
 * Field names must stay aligned with the create-project API.
 */
export function buildProjectCreateFormData(fields, files) {
  const formData = new FormData()
  const body = fields || {}
  formData.append('user_prompt', body.user_prompt ?? '')
  if (body.model_id) {
    formData.append('model_id', body.model_id)
    if (body.force_model) formData.append('force_model', 'true')
  } else if (body.run_config_id) {
    formData.append('run_config_id', body.run_config_id)
  }
  if (body.workflow_id) formData.append('workflow_id', body.workflow_id)
  if (body.approval_mode) formData.append('approval_mode', body.approval_mode)
  if (body.reasoning) formData.append('reasoning', JSON.stringify(body.reasoning))
  if (body.temperature != null) formData.append('temperature', String(body.temperature))
  for (const f of files || []) {
    if (f) formData.append('files', f, f.name)
  }
  return formData
}

/**
 * Multipart body for POST /projects/{id}/messages (text+files or files-only).
 * Empty content is intentional for files-only; backend supplies a stub title.
 */
export function buildMessageSendFormData(content, files) {
  const formData = new FormData()
  formData.append('content', content ?? '')
  for (const f of files || []) {
    if (f) formData.append('files', f, f.name)
  }
  return formData
}

/**
 * Map message.attachments[] to chip props for UserMessage (and similar).
 * @returns {{ key: string, label: string, sizeBytes: *, mime: string, downloadUrl: string }[]}
 */
export function userMessageAttachmentEntries(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  return attachments.map((att) => {
    const label = att?.filename || att?.id || 'attachment'
    return {
      key: String(att?.id || label),
      label,
      sizeBytes: att?.size_bytes,
      mime: att?.content_type ? String(att.content_type) : '',
      downloadUrl: att?.download_url ? String(att.download_url) : '',
    }
  })
}

/**
 * Paginate GET /projects/{id}/attachments until every user upload is listed.
 * @param {string} projectId
 * @param {(url: string) => Promise<Response>} fetchFn — typically apiFetch
 */
export async function fetchAllProjectUserAttachments(projectId, fetchFn) {
  if (!projectId || !fetchFn) return []
  const all = []
  let skip = 0
  while (true) {
    const res = await fetchFn(
      `/projects/${projectId}/attachments?limit=${USER_ATTACHMENT_LIST_PAGE_SIZE}&skip=${skip}`,
    )
    if (!res.ok) {
      throw new Error(`Failed to list attachments (${res.status})`)
    }
    const data = await res.json()
    const page = Array.isArray(data?.attachments) ? data.attachments : []
    all.push(...page)
    if (!data?.truncated || page.length === 0) break
    skip += USER_ATTACHMENT_LIST_PAGE_SIZE
  }
  return all
}
