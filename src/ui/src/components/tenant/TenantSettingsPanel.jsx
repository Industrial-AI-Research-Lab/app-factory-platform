import { Save } from 'lucide-react'
import ModelPicker from '../ModelPicker'

function parseFallback(str) {
  return str ? str.split(',').map(s => s.trim()).filter(Boolean) : []
}

export default function TenantSettingsPanel({ form, saving, saveDisabled = false, onFieldChange, onSave, children }) {
  if (!form) return null

  const fallbackList = parseFallback(form.fallback_models)

  const addFallback = (val) => {
    if (!val || fallbackList.includes(val)) return
    onFieldChange('fallback_models', [...fallbackList, val].join(', '))
  }

  const removeFallback = (idx) => {
    onFieldChange('fallback_models', fallbackList.filter((_, i) => i !== idx).join(', '))
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <label className="block"><span className="text-xs text-slate-400">LLM Provider</span><select value={form.llm_provider} onChange={e => onFieldChange('llm_provider', e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1"><option value="bifrost">bifrost</option><option value="openai">openai</option></select></label>
        <label className="block"><span className="text-xs text-slate-400">Bifrost Virtual Key</span><input type="text" value={form.bifrost_vk} onChange={e => onFieldChange('bifrost_vk', e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
        <label className="block"><span className="text-xs text-slate-400">OpenAI API Key</span><input type="text" value={form.openai_api_key} onChange={e => onFieldChange('openai_api_key', e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
        <label className="block"><span className="text-xs text-slate-400">Bifrost URL</span><input type="text" value={form.bifrost_url} onChange={e => onFieldChange('bifrost_url', e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
        <label className="block"><span className="text-xs text-slate-400">Bifrost Provider</span><input type="text" value={form.bifrost_provider} onChange={e => onFieldChange('bifrost_provider', e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
        <div className="block">
          <span className="text-xs text-slate-400 block mb-1">Default Model</span>
          <ModelPicker value={form.default_model} onChange={val => onFieldChange('default_model', val)} />
        </div>
        <div className="block">
          <span className="text-xs text-slate-400 block mb-1">Fallback Models</span>
          {fallbackList.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {fallbackList.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-700 text-xs text-slate-200">
                  {m}
                  <button
                    type="button"
                    onClick={() => removeFallback(i)}
                    className="text-slate-400 hover:text-red-400 leading-none ml-0.5"
                    title="Remove"
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <ModelPicker value="" onChange={addFallback} />
        </div>
        <label className="block"><span className="text-xs text-slate-400">Max Concurrent Projects</span><input type="number" min="1" value={form.max_concurrent_projects} onChange={e => onFieldChange('max_concurrent_projects', e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" /></label>
      </div>
      {children}
      <div className="flex justify-end items-center gap-3">
        {saveDisabled && (
          <span className="text-[11px] text-red-400">Fix invalid plugin configuration before saving</span>
        )}
        <button onClick={onSave} disabled={saving || saveDisabled} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
          <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
