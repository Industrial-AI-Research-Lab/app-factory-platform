/** Query string for GET /configurations/tools/ (server-side list filters). */
export function buildToolConfigurationsListQuery({
  searchQuery = '',
  statusFilter = 'all',
  categoryFilter = '',
} = {}) {
  const params = new URLSearchParams()
  const q = String(searchQuery || '').trim()
  if (q) params.set('q', q)

  if (statusFilter === 'enabled') {
    params.set('enabled', 'true')
  } else if (statusFilter === 'disabled') {
    params.set('enabled_only', 'false')
    params.set('enabled', 'false')
  }

  const category = String(categoryFilter || '').trim()
  if (category) params.set('category', category)

  const qs = params.toString()
  return qs ? `/configurations/tools/?${qs}` : '/configurations/tools/'
}

/** Keep category filter in sync with dictionary options ('' = All categories). */
export function resolveCategoryFilter(filter, categories) {
  const value = String(filter ?? '').trim()
  if (!value) return ''
  return (Array.isArray(categories) ? categories : []).includes(value) ? value : ''
}
