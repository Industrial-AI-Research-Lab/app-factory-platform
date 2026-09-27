import { useCallback, useEffect, useState } from 'react'
import { Building2, RefreshCw } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import McpExportKeySection from '../components/auth/McpExportKeySection'
import TenantSettingsPanel from '../components/tenant/TenantSettingsPanel'
import PluginsCard from '../components/tenant/PluginsCard'
import { useAuth } from '../hooks/useAuth.jsx'
import { apiFetch } from '../utils_api'
import { buildSettingsPayload, isSecretField, normalizeSettings } from './tenantManagementUtils'

export default function TenantSettings() {
  const { user } = useAuth()
  const tenantId = user?.tenant_id || ''
  const canManageExportKey = user?.role === 'root' || user?.role === 'tenant_admin'
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // Non-null while a plugin's config JSON is unparseable — blocks Save so a
  // broken config never reaches the PUT (the backend would drop it to
  // "not configured" rather than reject it).
  const [pluginConfigError, setPluginConfigError] = useState(null)
  // Bumped on every settings load so the Plugins card remounts and re-seeds its
  // config editors from fresh server state on Refresh. A Save doesn't bump it —
  // that path keeps the editors as the user left them.
  const [reloadKey, setReloadKey] = useState(0)

  const fetchSettings = useCallback(async () => {
    if (!tenantId) {
      setError('Your account is not bound to a tenant')
      setForm(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/tenants/${tenantId}/settings`)
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to load tenant settings')
      }
      const data = await res.json()
      setForm(normalizeSettings(data))
      setReloadKey(k => k + 1)
    } catch (err) {
      setError(err.message || 'Failed to load tenant settings')
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const updateField = (field, value) => {
    setForm(prev => {
      const current = prev || normalizeSettings()
      const next = { ...current, [field]: value }
      if (isSecretField(field)) {
        next._touchedSecrets = { ...current._touchedSecrets, [field]: true }
      }
      return next
    })
  }

  const saveSettings = async () => {
    if (!tenantId || !form) return
    const payload = buildSettingsPayload(form)
    if (Object.keys(payload).length === 0) {
      alert('No changed fields to save')
      return
    }

    setSaving(true)
    try {
      const res = await apiFetch(`/tenants/${tenantId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || 'Failed to save tenant settings')
      }
      const updated = await res.json()
      setForm(normalizeSettings(updated))
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">Tenant Settings</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            Tenant Settings
          </h1>
          <button
            onClick={fetchSettings}
            disabled={loading}
            className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        <div className="text-xs text-slate-400 mb-4">
          Tenant ID: <span className="font-mono text-slate-300">{tenantId || 'N/A'}</span>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">
            {error}
          </div>
        )}
        {loading && <div className="text-slate-400 text-sm">Loading...</div>}

        {!loading && !error && form && (
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
            <TenantSettingsPanel
              form={form}
              saving={saving}
              saveDisabled={!!pluginConfigError}
              onFieldChange={updateField}
              onSave={saveSettings}
            >
              <PluginsCard
                key={reloadKey}
                plugins={form.plugins || {}}
                onChange={next => updateField('plugins', next)}
                onErrorChange={setPluginConfigError}
              />
            </TenantSettingsPanel>
            {canManageExportKey && <McpExportKeySection tenantId={tenantId} />}
          </div>
        )}
      </main>
    </div>
  )
}

