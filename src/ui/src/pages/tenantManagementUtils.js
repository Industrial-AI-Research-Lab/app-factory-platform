export const SYSTEM_TENANTS = new Set(['__root__', '__system__'])
const SECRET_FIELDS = new Set(['bifrost_vk', 'openai_api_key'])

export function emptyCreateForm() {
  return { id: '', name: '', enabled: true }
}

function parseFallbackModels(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(',').map(v => v.trim()).filter(Boolean)
}

function parseOptionalInt(value) {
  if (value === '' || value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

function normalizePlugins(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function clonePlugins(value) {
  try {
    return JSON.parse(JSON.stringify(normalizePlugins(value)))
  } catch {
    return {}
  }
}

export function normalizeSettings(raw = {}) {
  const fallbackModels = parseFallbackModels(raw.fallback_models)
  const plugins = normalizePlugins(raw.plugins)
  const normalized = {
    llm_provider: raw.llm_provider || 'bifrost',
    bifrost_vk: raw.bifrost_vk || '',
    openai_api_key: raw.openai_api_key || '',
    bifrost_url: raw.bifrost_url || '',
    bifrost_provider: raw.bifrost_provider || 'openrouter',
    default_model: raw.default_model || '',
    fallback_models: fallbackModels.join(', '),
    max_concurrent_projects: raw.max_concurrent_projects ?? '',
    plugins,
  }
  return {
    ...normalized,
    _touchedSecrets: { bifrost_vk: false, openai_api_key: false },
    // Deep-clone plugins for the diff baseline: the Plugins card edits
    // form.plugins immutably, but a shared ref would still let a stray
    // in-place mutation corrupt the "changed?" comparison in buildSettingsPayload.
    _original: { ...normalized, plugins: clonePlugins(plugins) },
  }
}

export function buildSettingsPayload(form) {
  const payload = {}
  const original = form?._original || {}

  if (form.llm_provider && form.llm_provider !== original.llm_provider) {
    payload.llm_provider = form.llm_provider
  }
  if (form.bifrost_url && form.bifrost_url !== original.bifrost_url) {
    payload.bifrost_url = form.bifrost_url
  }
  if (form.bifrost_provider && form.bifrost_provider !== original.bifrost_provider) {
    payload.bifrost_provider = form.bifrost_provider
  }
  if (form.default_model && form.default_model !== original.default_model) {
    payload.default_model = form.default_model
  }

  const fallbackModels = parseFallbackModels(form.fallback_models)
  const originalFallback = parseFallbackModels(original.fallback_models)
  if (JSON.stringify(fallbackModels) !== JSON.stringify(originalFallback) && fallbackModels.length > 0) {
    payload.fallback_models = fallbackModels
  }

  const maxConcurrentProjects = parseOptionalInt(form.max_concurrent_projects)
  const originalMaxConcurrentProjects = parseOptionalInt(original.max_concurrent_projects)
  if (maxConcurrentProjects != null && maxConcurrentProjects !== originalMaxConcurrentProjects) {
    payload.max_concurrent_projects = maxConcurrentProjects
  }

  for (const field of SECRET_FIELDS) {
    if (!form._touchedSecrets?.[field]) continue
    const value = typeof form[field] === 'string' ? form[field].trim() : ''
    if (!value || value.includes('***')) continue
    if (value !== original[field]) payload[field] = value
  }

  // The PUT replaces the whole `plugins` section (top-level merge), so when it
  // changed we send the ENTIRE object the card produced — a delta would wipe
  // the plugins the user didn't touch.
  const plugins = normalizePlugins(form.plugins)
  const originalPlugins = normalizePlugins(original.plugins)
  if (JSON.stringify(plugins) !== JSON.stringify(originalPlugins)) {
    payload.plugins = plugins
  }

  return payload
}

export function isSecretField(field) {
  return SECRET_FIELDS.has(field)
}
