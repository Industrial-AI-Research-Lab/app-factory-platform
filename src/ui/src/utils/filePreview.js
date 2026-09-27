/** Read-only file preview helpers shared by the artifact viewers. */
import { apiJson } from '../utils_api'
import { fileExtension } from './attachmentFiles'

/** Keep in sync with TEXT_PREVIEW_EXTENSIONS / OFFICE_PREVIEW_EXTENSIONS in file_attachments.py. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.json', '.csv', '.js', '.jsx', '.ts', '.tsx',
  '.yml', '.yaml', '.html', '.css', '.sh',
])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])
const PDF_EXTENSIONS = new Set(['.pdf'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx'])

/** @returns {'text'|'image'|'pdf'|'office'|'unknown'} */
export function previewKind(filename) {
  const ext = fileExtension(filename)
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  return 'unknown'
}

export function isPreviewable(filename) {
  const kind = previewKind(filename)
  // PDF objects are stored with Content-Disposition: attachment, so an iframe
  // just triggers a download. Keep View for types we can actually show.
  return kind === 'text' || kind === 'image' || kind === 'office'
}

export function basename(path) {
  if (!path) return ''
  const parts = String(path).split(/[/\\]/)
  return parts[parts.length - 1]
}

export function toDisplayText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function monacoLanguage(path) {
  const ext = (path || '').toLowerCase().split('.').pop()
  switch (ext) {
    case 'py': return 'python'
    case 'js':
    case 'jsx': return 'javascript'
    case 'ts':
    case 'tsx': return 'typescript'
    case 'json': return 'json'
    case 'md': return 'markdown'
    case 'html': return 'html'
    case 'css': return 'css'
    case 'yml':
    case 'yaml': return 'yaml'
    case 'sh': return 'shell'
    default: return 'plaintext'
  }
}

/**
 * Text of a stored file through the API (never the presigned S3 URL, which the
 * browser cannot read cross-origin).
 * @returns {Promise<{ text: string, truncated: boolean, extracted: boolean }>}
 */
export async function fetchPreviewText(previewUrl) {
  if (!previewUrl) throw new Error('Preview is not available for this file')
  const data = await apiJson(previewUrl)
  return {
    text: toDisplayText(data?.text),
    truncated: Boolean(data?.truncated),
    extracted: Boolean(data?.extracted),
  }
}
