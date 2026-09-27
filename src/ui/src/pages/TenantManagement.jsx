import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Settings,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import CreateTenantModal from '../components/tenant/CreateTenantModal'
import TenantSettingsPanel from '../components/tenant/TenantSettingsPanel'
import PluginsCard from '../components/tenant/PluginsCard'
import { apiFetch } from '../utils_api'
import {
  buildSettingsPayload,
  emptyCreateForm,
  isSecretField,
  normalizeSettings,
  SYSTEM_TENANTS,
} from './tenantManagementUtils'

export default function TenantManagement() {
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState({})
  const [nameDrafts, setNameDrafts] = useState({})
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState(emptyCreateForm())
  const [expandedId, setExpandedId] = useState(null)
  const [settings, setSettings] = useState({})
  // tenantId -> plugin-config-JSON error (or null). Blocks that tenant's Save.
  const [pluginErrors, setPluginErrors] = useState({})

  const fetchTenants = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/tenants/')
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to fetch tenants')
      }
      setTenants(await res.json())
    } catch (err) {
      setError(err.message || 'Failed to fetch tenants')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTenants() }, [fetchTenants])

  const loadSettings = async (tenantId) => {
    setSaving(prev => ({ ...prev, [`settings-load:${tenantId}`]: true }))
    try {
      const res = await apiFetch(`/tenants/${tenantId}/settings`)
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to load settings')
      }
      const data = await res.json()
      setSettings(prev => ({ ...prev, [tenantId]: normalizeSettings(data) }))
    } catch (err) {
      alert(`Failed to load settings: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [`settings-load:${tenantId}`]: false }))
    }
  }

  const toggleExpanded = (tenantId, tenantName) => {
    const nextExpanded = expandedId === tenantId ? null : tenantId
    setExpandedId(nextExpanded)
    if (!nextExpanded) return

    setNameDrafts(prev => {
      if (typeof prev[tenantId] === 'string') return prev
      return { ...prev, [tenantId]: tenantName || '' }
    })
    if (!settings[tenantId]) loadSettings(tenantId)
  }

  const updateSettingField = (tenantId, field, value) => {
    setSettings(prev => {
      const existing = prev[tenantId] || normalizeSettings()
      const updated = { ...existing, [field]: value }
      if (isSecretField(field)) {
        updated._touchedSecrets = { ...existing._touchedSecrets, [field]: true }
      }
      return { ...prev, [tenantId]: updated }
    })
  }

  const toggleEnabled = async (tenant) => {
    const tenantId = tenant.id
    setSaving(prev => ({ ...prev, [`toggle:${tenantId}`]: true }))
    try {
      const res = await apiFetch(`/tenants/${tenantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !tenant.enabled }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to update tenant')
      }
      const updated = await res.json()
      setTenants(prev => prev.map(t => (t.id === tenantId ? updated : t)))
    } catch (err) {
      alert(`Toggle failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [`toggle:${tenantId}`]: false }))
    }
  }

  const deleteTenant = async (tenant) => {
    const tenantId = tenant.id
    if (SYSTEM_TENANTS.has(tenantId)) return
    if (!confirm(`Delete tenant "${tenant.name}" (${tenantId})?`)) return

    setSaving(prev => ({ ...prev, [`delete:${tenantId}`]: true }))
    try {
      const res = await apiFetch(`/tenants/${tenantId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to delete tenant')
      }
      setTenants(prev => prev.filter(t => t.id !== tenantId))
      if (expandedId === tenantId) setExpandedId(null)
      setSettings(prev => {
        const next = { ...prev }
        delete next[tenantId]
        return next
      })
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [`delete:${tenantId}`]: false }))
    }
  }

  const saveTenantName = async (tenantId) => {
    const tenant = tenants.find(t => t.id === tenantId)
    if (!tenant) return

    const draftName = (nameDrafts[tenantId] ?? tenant.name ?? '').trim()
    if (!draftName) {
      alert('Tenant name is required')
      return
    }
    if (draftName === tenant.name) return

    setSaving(prev => ({ ...prev, [`name-save:${tenantId}`]: true }))
    try {
      const res = await apiFetch(`/tenants/${tenantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draftName }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to update tenant')
      }
      const updated = await res.json()
      setTenants(prev => prev.map(t => (t.id === tenantId ? updated : t)))
      setNameDrafts(prev => ({ ...prev, [tenantId]: updated.name || draftName }))
    } catch (err) {
      alert(`Update failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [`name-save:${tenantId}`]: false }))
    }
  }

  const saveTenantSettings = async (tenantId) => {
    const form = settings[tenantId]
    if (!form) return
    const payload = buildSettingsPayload(form)
    if (Object.keys(payload).length === 0) {
      alert('No changed fields to save')
      return
    }

    setSaving(prev => ({ ...prev, [`settings-save:${tenantId}`]: true }))
    try {
      const res = await apiFetch(`/tenants/${tenantId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to save settings')
      }
      const updated = await res.json()
      setSettings(prev => ({ ...prev, [tenantId]: normalizeSettings(updated) }))
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [`settings-save:${tenantId}`]: false }))
    }
  }

  const createTenant = async () => {
    const tenantId = createForm.id.trim()
    const tenantName = createForm.name.trim()
    if (!tenantId || !tenantName) { alert('ID and Name are required'); return }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(tenantId)) {
      alert('Tenant ID must start with a lowercase letter, be 2-64 characters long, and contain only lowercase letters, digits, or underscores.')
      return
    }

    setSaving(prev => ({ ...prev, create: true }))
    try {
      const res = await apiFetch('/tenants/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tenantId, name: tenantName, enabled: createForm.enabled }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        if (res.status === 409) throw new Error('Tenant already exists')
        throw new Error(e.detail || 'Failed to create tenant')
      }
      setShowCreate(false)
      setCreateForm(emptyCreateForm())
      await fetchTenants()
    } catch (err) {
      alert(`Create failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, create: false }))
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">Tenant Management</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2"><Building2 className="w-5 h-5" /> Tenants</h1>
          <div className="flex items-center gap-2">
            <button onClick={fetchTenants} className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button onClick={() => { setShowCreate(true); setCreateForm(emptyCreateForm()) }} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> New Tenant
            </button>
          </div>
        </div>

        {error && <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">{error}</div>}
        {loading && <div className="text-slate-400 text-sm">Loading...</div>}

        {/* No overflow-hidden: PluginsCard Monaco suggest uses fixedOverflowWidgets but
            stays under this ancestor — clip would cut autocomplete (AppFactory-307). */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 border-b border-slate-700">
                <th className="text-left px-4 py-2">ID</th>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-center px-4 py-2">Enabled</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map(tenant => {
                const tenantId = tenant.id
                const isExpanded = expandedId === tenantId
                const isSystemTenant = SYSTEM_TENANTS.has(tenantId)
                const rowSaving =
                  saving[`toggle:${tenantId}`] ||
                  saving[`delete:${tenantId}`] ||
                  saving[`name-save:${tenantId}`] ||
                  saving[`settings-save:${tenantId}`]
                const nameDraft = nameDrafts[tenantId] ?? tenant.name ?? ''
                const nameChanged = nameDraft.trim().length > 0 && nameDraft.trim() !== tenant.name
                return (
                  <Fragment key={tenantId}>
                    <tr className="border-b border-slate-700/50 hover:bg-slate-750">
                      <td className="px-4 py-2 font-mono text-xs">{tenantId}</td>
                      <td className="px-4 py-2">{tenant.name}</td>
                      <td className="px-4 py-2 text-center">
                        <button onClick={() => toggleEnabled(tenant)} disabled={saving[`toggle:${tenantId}`]} className="inline-flex items-center disabled:opacity-50">
                          {tenant.enabled ? <ToggleRight className="w-5 h-5 text-green-400" /> : <ToggleLeft className="w-5 h-5 text-slate-500" />}
                        </button>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => toggleExpanded(tenantId, tenant.name)} disabled={rowSaving} className="px-2 py-1 text-xs text-slate-300 hover:text-white disabled:opacity-50" title="Tenant settings">
                            <span className="inline-flex items-center gap-1">
                              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              <Settings className="w-3.5 h-3.5" />
                            </span>
                          </button>
                          <button onClick={() => deleteTenant(tenant)} disabled={isSystemTenant || saving[`delete:${tenantId}`]} className="px-2 py-1 text-xs text-red-400 hover:text-red-300 disabled:opacity-30" title={isSystemTenant ? 'System tenant cannot be deleted' : 'Delete tenant'}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-slate-700/50 bg-slate-900/30">
                        <td colSpan={4} className="px-4 py-4">
                          <div className="mb-4">
                            <label className="block">
                              <span className="text-xs text-slate-400">Tenant Name</span>
                              <div className="mt-1 flex items-center gap-2">
                                <input
                                  type="text"
                                  value={nameDraft}
                                  onChange={e => setNameDrafts(prev => ({ ...prev, [tenantId]: e.target.value }))}
                                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
                                  disabled={saving[`name-save:${tenantId}`]}
                                />
                                <button
                                  onClick={() => saveTenantName(tenantId)}
                                  disabled={saving[`name-save:${tenantId}`] || !nameChanged}
                                  className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
                                >
                                  {saving[`name-save:${tenantId}`] ? 'Saving...' : 'Save Name'}
                                </button>
                              </div>
                            </label>
                          </div>
                          {saving[`settings-load:${tenantId}`] && <div className="text-xs text-slate-400 mb-3">Loading tenant settings...</div>}
                          {settings[tenantId] && (
                            <TenantSettingsPanel
                              form={settings[tenantId]}
                              saving={saving[`settings-save:${tenantId}`]}
                              saveDisabled={!!pluginErrors[tenantId]}
                              onFieldChange={(field, value) => updateSettingField(tenantId, field, value)}
                              onSave={() => saveTenantSettings(tenantId)}
                            >
                              <PluginsCard
                                key={tenantId}
                                plugins={settings[tenantId].plugins || {}}
                                onChange={next => updateSettingField(tenantId, 'plugins', next)}
                                onErrorChange={err => setPluginErrors(prev => ({ ...prev, [tenantId]: err }))}
                              />
                            </TenantSettingsPanel>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {!loading && tenants.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">No tenants found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      <CreateTenantModal
        show={showCreate}
        form={createForm}
        setForm={setCreateForm}
        onClose={() => setShowCreate(false)}
        onCreate={createTenant}
        saving={saving.create}
      />
    </div>
  )
}

