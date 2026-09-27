import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { apiFetch } from '../../utils_api'
import PluginParamsReference from './PluginParamsReference'

// The per-plugin settings object is { enabled, ...config }. The toggle owns
// `enabled` (always written as a JSON boolean — a string "false" would read as
// truthy and silently enable the plugin); the textarea owns the rest.

function configWithoutEnabled(pluginObj) {
  const { enabled, ...rest } = pluginObj || {}
  return rest
}

function prettyConfig(pluginObj) {
  const rest = configWithoutEnabled(pluginObj)
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''
}

function applyEnabled(config, enabled) {
  return { ...config, enabled: !!enabled }
}

function parseConfig(text) {
  const t = (text || '').trim()
  if (!t) return { ok: true, value: {} }
  let parsed
  try {
    parsed = JSON.parse(t)
  } catch {
    return { ok: false, error: 'Invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Configuration must be a JSON object' }
  }
  return { ok: true, value: parsed }
}

// Monaco JSON schema bindings from the plugin catalog: one entry per plugin that
// ships a config_schema, each bound to a stable per-plugin model URI so its
// editor validates/autocompletes against its own schema. A plugin with no schema
// is skipped (plain JSON, no suggestions) rather than bound to an empty schema.
// Exported for unit testing the binding without a browser/Monaco runtime.
export function buildPluginSchemas(catalog) {
  return (catalog || [])
    .filter((p) => p && p.config_schema && Object.keys(p.config_schema).length > 0)
    .map((p) => {
      const uri = `internal://plugin-config/${p.name}`
      return { uri, fileMatch: [uri], schema: p.config_schema }
    })
}

// Monaco marker severity for an Error is 8 (Warning 4, Info 2, Hint 1). A schema
// violation blocks Save only at Error severity — which registerSchemas pins schema
// problems to. Exported for unit testing without a Monaco runtime.
export function hasSchemaError(markers) {
  return Array.isArray(markers) && markers.some((m) => m && m.severity === 8)
}

// Collapsed matches the historical 150px field; expanded mirrors MonacoJsonField (AppFactory-304).
export const PLUGIN_MONACO_HEIGHT = { collapsed: '150px', expanded: '360px' }

export default function PluginsCard({ plugins = {}, onChange, onErrorChange }) {
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)
  // name -> current editor text; name -> parse error (or null)
  const [configText, setConfigText] = useState({})
  const [configErr, setConfigErr] = useState({})
  // name -> true when Monaco reports an Error-severity schema marker (type mismatch /
  // unknown key). Separate from configErr (JSON parse) because it arrives async from
  // the worker, after onChange — OR'd into the Save gate below.
  const [schemaErr, setSchemaErr] = useState({})
  // name -> is the Advanced (raw-JSON) editor open. Collapsed by default: no
  // plugin exposes config keys yet, so a bare box is just a mystery. A plugin
  // that already has saved config opens so existing config is never hidden.
  const [expanded, setExpanded] = useState({})
  // name -> Monaco field taller than the default 150px (AppFactory-307 Expand)
  const [editorTall, setEditorTall] = useState({})

  // Fetch once: the catalog of AVAILABLE plugins is registry-driven, so a fresh
  // tenant (nothing saved yet) still sees what it can enable. Seed the editors
  // from current settings here and never re-seed from props, so a toggle or a
  // parent re-render can't wipe an in-progress edit.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setFetchError(null)
      try {
        const res = await apiFetch('/settings/plugins')
        if (!res.ok) throw new Error('Failed to load plugin catalog')
        const data = await res.json()
        if (cancelled) return
        const list = Array.isArray(data.plugins) ? data.plugins : []
        setCatalog(list)
        const seeded = {}
        const opened = {}
        for (const p of list) {
          seeded[p.name] = prettyConfig(plugins[p.name])
          opened[p.name] = Object.keys(configWithoutEnabled(plugins[p.name])).length > 0
        }
        setConfigText(seeded)
        setExpanded(opened)
      } catch (err) {
        if (!cancelled) setFetchError(err.message || 'Failed to load plugin catalog')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Intentionally mount-only: see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Surface config validity so the parent can block Save — the backend degrades
  // bad config to "not configured"/defaults, so the guard has to live on the
  // client. Two sources block Save: configErr (JSON parse) and schemaErr (schema
  // validation); either one is enough.
  //
  // The effect depends ONLY on the two error maps (the real triggers) and reads the
  // callback from a ref. Taking onErrorChange as a dep loops forever when the
  // parent passes an inline callback whose setState makes a new object each
  // render (TenantManagement): notify → parent re-render → new callback
  // identity → effect re-fires → "Maximum update depth exceeded".
  const onErrorChangeRef = useRef(onErrorChange)
  useEffect(() => {
    onErrorChangeRef.current = onErrorChange
  })
  useEffect(() => {
    const hasError =
      Object.values(configErr).some(Boolean) || Object.values(schemaErr).some(Boolean)
    onErrorChangeRef.current?.(hasError ? 'Fix invalid plugin configuration before saving' : null)
  }, [configErr, schemaErr])

  const handleToggle = useCallback(
    (name) => {
      const nextEnabled = !(plugins[name]?.enabled === true)
      // Keep whatever the editor holds if it currently parses; otherwise fall
      // back to the last saved config so a mid-edit toggle can't lose keys.
      const res = parseConfig(configText[name])
      const baseConfig = res.ok ? res.value : configWithoutEnabled(plugins[name])
      onChange?.({ ...plugins, [name]: applyEnabled(baseConfig, nextEnabled) })
    },
    [plugins, configText, onChange],
  )

  const handleConfigChange = useCallback(
    (name, text) => {
      setConfigText((prev) => ({ ...prev, [name]: text }))
      const res = parseConfig(text)
      setConfigErr((prev) => ({ ...prev, [name]: res.ok ? null : res.error }))
      if (res.ok) {
        const enabled = plugins[name]?.enabled === true
        onChange?.({ ...plugins, [name]: applyEnabled(res.value, enabled) })
      }
    },
    [plugins, onChange],
  )

  const handleValidate = useCallback((name, markers) => {
    // Monaco delivers schema markers async (JSON worker), after onChange. With
    // schemaValidation:'error' set below, a type mismatch or unknown key arrives as
    // Error severity — gate Save on it like a parse error so the red squiggle can't
    // be saved past. onValidate re-fires with [] once the model is valid, clearing
    // the flag. Skip the write when unchanged so re-validation doesn't churn renders.
    const next = hasSchemaError(markers)
    setSchemaErr((prev) => (!!prev[name] === next ? prev : { ...prev, [name]: next }))
  }, [])

  // Feed each plugin's config_schema to Monaco so the editor autocompletes keys,
  // shows their descriptions on hover, and flags unknown keys (the schema is
  // additionalProperties:false) — e.g. a stale key name or a double-nested config
  // surfaces as a red squiggle instead of silently reading as defaults. Each
  // plugin's editor is bound to its schema by a stable per-plugin model URI.
  // schemaValidation:'error' pins schema problems (type mismatch, unknown key) to
  // Error severity rather than Monaco's default: deterministically red, and caught
  // by onValidate below so a schema-invalid config can't be saved past the squiggle.
  const registerSchemas = useCallback((monaco) => {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      schemaValidation: 'error',
      schemas: buildPluginSchemas(catalog),
    })
  }, [catalog])

  return (
    <div className="mt-4 border-t border-slate-700 pt-4">
      <h2 className="text-sm font-semibold mb-1">Plugins</h2>
      <p className="text-xs text-slate-400 mb-3">
        Enable and configure plugins for this tenant. Changes apply from the next agent run — no restart needed.
      </p>

      {loading && <div className="text-slate-400 text-sm">Loading plugins…</div>}
      {fetchError && (
        <div className="text-red-300 text-sm bg-red-900/30 border border-red-800 rounded px-3 py-2">
          {fetchError}
        </div>
      )}
      {!loading && !fetchError && catalog.length === 0 && (
        <div className="text-slate-400 text-sm">No plugins are available.</div>
      )}

      <div className="space-y-3">
        {catalog.map((p) => {
          const enabled = plugins[p.name]?.enabled === true
          // Parse error wins the message (schema validation on unparseable JSON is
          // moot); a schema error still blocks Save and force-opens the editor.
          const err =
            configErr[p.name] ||
            (schemaErr[p.name] ? 'Configuration does not match the plugin schema' : null)
          // Force-open on error: a collapsed editor must never hide the reason
          // Save is blocked.
          const open = expanded[p.name] || !!err
          return (
            <div key={p.name} className="bg-slate-900/40 border border-slate-700 rounded p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-200 font-mono">{p.name}</div>
                  {p.description && <div className="text-xs text-slate-400 mt-0.5">{p.description}</div>}
                  {Array.isArray(p.subscribed_hooks) && p.subscribed_hooks.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {p.subscribed_hooks.map((h) => (
                        <span
                          key={h}
                          className="px-1.5 py-0.5 rounded bg-slate-700 text-[10px] text-slate-300 font-mono"
                          title="Hook this plugin subscribes to (set in code, read-only)"
                        >
                          {h}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${enabled ? 'Disable' : 'Enable'} ${p.name}`}
                  onClick={() => handleToggle(p.name)}
                  className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    enabled ? 'bg-blue-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              <PluginParamsReference schema={p.config_schema} guide={p.guide} groups={p.param_groups} />

              <div className="mt-2">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded((prev) => ({ ...prev, [p.name]: !open }))}
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                >
                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Advanced configuration (JSON)
                </button>
                {open && (
                  <div className="mt-1.5">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[11px] text-slate-500">
                        Optional. Start typing a key for suggestions; unknown keys are flagged.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setEditorTall((prev) => ({ ...prev, [p.name]: !prev[p.name] }))
                        }
                        className="shrink-0 text-[11px] text-slate-400 hover:text-slate-200"
                      >
                        {editorTall[p.name] ? 'Collapse editor' : 'Expand editor'}
                      </button>
                    </div>
                    <div
                      className={`border rounded ${err ? 'border-red-600' : 'border-slate-600'}`}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Editor
                        height={
                          editorTall[p.name]
                            ? PLUGIN_MONACO_HEIGHT.expanded
                            : PLUGIN_MONACO_HEIGHT.collapsed
                        }
                        language="json"
                        theme="vs-dark"
                        path={`internal://plugin-config/${p.name}`}
                        defaultValue={configText[p.name] ?? ''}
                        onChange={(text) => handleConfigChange(p.name, text ?? '')}
                        onValidate={(markers) => handleValidate(p.name, markers)}
                        beforeMount={registerSchemas}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 12,
                          lineNumbers: 'off',
                          wordWrap: 'on',
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          tabSize: 2,
                          folding: false,
                          renderLineHighlight: 'none',
                          fixedOverflowWidgets: true,
                        }}
                      />
                    </div>
                    {err && <div className="text-[11px] text-red-400 mt-0.5">{err}</div>}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
