export const PREVIEW_CHAR_LIMIT = 20000

export function truncatePreviewText(value, limit = PREVIEW_CHAR_LIMIT) {
  const text = value == null ? '' : (typeof value === 'string' ? value : String(value))

  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      text,
      isTruncated: false,
      originalLength: text.length,
    }
  }

  if (text.length <= limit) {
    return {
      text,
      isTruncated: false,
      originalLength: text.length,
    }
  }

  return {
    text: text.slice(0, limit),
    isTruncated: true,
    originalLength: text.length,
  }
}
