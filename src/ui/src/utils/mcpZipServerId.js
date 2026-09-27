/** ZIP-import MCP server_id: always suffixed with ``-zip`` (matches backend). */

const ZIP_SUFFIX = '-zip'
const STRIP_SUFFIXES = ['-main', '-master']

export function normalizeZipImportServerId(serverId) {
  let stem = String(serverId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!stem) stem = 'mcp'
  if (stem.endsWith(ZIP_SUFFIX)) return stem.slice(0, 64)
  const maxBase = 64 - ZIP_SUFFIX.length
  const base = stem.slice(0, maxBase).replace(/-+$/, '')
  return `${base}${ZIP_SUFFIX}`
}

export function suggestServerIdFromZipFilename(filename) {
  let raw = String(filename || '').toLowerCase().replace(/\.zip$/i, '')
  for (const suf of STRIP_SUFFIXES) {
    if (raw.endsWith(suf)) raw = raw.slice(0, -suf.length)
  }
  return normalizeZipImportServerId(raw)
}
