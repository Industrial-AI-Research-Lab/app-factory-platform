import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Plus, Trash2, RefreshCw, AlertTriangle } from 'lucide-react'
import { apiFetch } from '../../utils_api'

const PART_OPTIONS = ['text', 'data']
const CONTEXT_KEY_DATALIST_ID = 'a2a-context-keys'

/** Required extensions whose param schema the backend auto-fills from the run prompt. */
function requiredParamExtensions(card) {
  const extensions = card?.capabilities?.extensions
  if (!Array.isArray(extensions)) return []
  return extensions.filter(
    (e) => e?.required && e?.params && typeof e.params.properties === 'object'
  )
}

/**
 * A2A-specific config fields: server picker, agent-card guidance, and structured reads/writes.
 *
 * a2a_agent reads/writes are arrays of dicts (NOT plain string keys like phase nodes):
 *   read  = { key, context_key, part }   -> pulls a context value into the agent message
 *   write = { artifact_name, context_key, required } -> requires the agent to fill a key
 * The node's server_id is the A2A server's Mongo _id, so the picker option value is that _id.
 *
 * `contextKeyOptions` ([{key, source}]) drives the context_key autocomplete so the author
 * picks from keys that actually exist in this workflow instead of guessing them.
 */
export default function A2aNodeFields({ form, servers, contextKeyOptions, onChange, disabled, validationIssues = [] }) {
  const reads = Array.isArray(form.reads) ? form.reads : []
  const writes = Array.isArray(form.writes) ? form.writes : []

  const serverOptions = (servers || []).map((s) => ({
    value: s._id || s.id,
    label: s.name || s._id || s.id,
  }))
  const serverId = form.server_id || ''
  const pollIssue = validationIssues.find((issue) => issue.fields?.includes('a2a_poll_interval_seconds'))
  const timeoutIssue = validationIssues.find((issue) => issue.fields?.includes('a2a_task_timeout_seconds'))
  const selectedKnown = !serverId || serverOptions.some((o) => o.value === serverId)
  const selectedServer = (servers || []).find((s) => (s._id || s.id) === serverId) || null

  // Agent card: prefer a freshly-discovered card (this session) over the one cached on the
  // server record. Reset the local override whenever the picked server changes.
  const [discoveredCard, setDiscoveredCard] = useState(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState('')
  useEffect(() => {
    setDiscoveredCard(null)
    setDiscoverError('')
  }, [serverId])

  const card = discoveredCard || selectedServer?.cached_agent_card_summary || null
  const skills = Array.isArray(card?.skills) ? card.skills : []
  const requiredExts = requiredParamExtensions(card)

  async function discoverCard() {
    if (!serverId || discovering) return
    setDiscovering(true)
    setDiscoverError('')
    try {
      // refresh-cache forces a live re-fetch + persists, but returns only counts — so we
      // re-GET the server to pull the full (rich) cached_agent_card_summary back.
      const refreshed = await apiFetch(`/configurations/a2a/${serverId}/refresh-cache`, { method: 'POST' })
      if (!refreshed.ok) {
        throw new Error(refreshed.status === 403 ? 'forbidden' : `status ${refreshed.status}`)
      }
      const res = await apiFetch(`/configurations/a2a/${serverId}`)
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = await res.json()
      const summary = data?.cached_agent_card_summary || null
      setDiscoveredCard(summary)
      if (!summary) setDiscoverError('Agent responded but published no card summary.')
    } catch (e) {
      setDiscoverError(
        e.message === 'forbidden'
          ? 'You need tenant-admin rights to refresh this card.'
          : 'Could not reach the agent to discover its card.'
      )
    } finally {
      setDiscovering(false)
    }
  }

  const updateRead = (idx, patch) =>
    onChange('reads', reads.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const addRead = () =>
    onChange('reads', [...reads, { key: '', context_key: '', part: 'text' }])
  const removeRead = (idx) =>
    onChange('reads', reads.filter((_, i) => i !== idx))

  const updateWrite = (idx, patch) =>
    onChange('writes', writes.map((w, i) => (i === idx ? { ...w, ...patch } : w)))
  const addWrite = () =>
    onChange('writes', [...writes, { artifact_name: '', context_key: '', required: false }])
  const removeWrite = (idx) =>
    onChange('writes', writes.filter((_, i) => i !== idx))

  const inputCls =
    'w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50'
  const rowInputCls =
    'w-full px-2 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-50'

  return (
    <>
      {/* Server picker */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">A2A Server</label>
        <select
          value={serverId}
          onChange={(e) => onChange('server_id', e.target.value)}
          disabled={disabled}
          className={inputCls}
        >
          <option value="">Select A2A server…</option>
          {serverOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {/* Preserve a server_id that isn't in the current tenant's list (e.g. imported
              from another tenant) instead of silently dropping it on the next save. */}
          {!selectedKnown && (
            <option value={serverId}>{serverId} (not in this tenant)</option>
          )}
        </select>
        <Link
          to="/configurations/a2a"
          target="_blank"
          className="inline-flex items-center gap-1 mt-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          <ExternalLink className="w-3 h-3" />
          Manage A2A servers
        </Link>
        {!serverId && (
          <div className="mt-2 p-2 bg-red-900/30 border border-red-700/50 rounded text-xs text-red-300">
            Required: pick the A2A server this node calls. The node fails preflight without it.
          </div>
        )}
        {serverId && !selectedKnown && (
          <div className="mt-2 p-2 bg-amber-900/30 border border-amber-700/50 rounded text-xs text-amber-300">
            This server id is not registered for the current tenant — the node will fail preflight. Re-pick a server from the list.
          </div>
        )}
      </div>

      {/* Agent card — what the picked agent offers and requires */}
      {serverId && selectedKnown && (
        <div className="rounded border border-cyan-700/40 bg-slate-900/40 p-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">Agent card</span>
            <button
              type="button"
              onClick={discoverCard}
              disabled={discovering}
              className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
              title="Re-fetch the agent's card from its endpoint"
            >
              <RefreshCw className={`w-3 h-3 ${discovering ? 'animate-spin' : ''}`} />
              {discovering ? 'Discovering…' : card ? 'Refresh' : 'Discover'}
            </button>
          </div>

          {discoverError && (
            <div className="flex items-start gap-1.5 p-1.5 bg-red-900/30 border border-red-700/50 rounded text-[11px] text-red-300">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{discoverError}</span>
            </div>
          )}

          {!card && !discovering && !discoverError && (
            <div className="text-[11px] text-slate-400">
              No card cached yet. Click <span className="text-cyan-300">Discover</span> to see what this agent offers and requires.
            </div>
          )}

          {card && (
            <>
              <div className="text-xs text-slate-300">
                {card.name || 'agent'}{card.version ? <span className="text-slate-500"> · v{card.version}</span> : null}
              </div>

              {/* Required inputs — the high-value guidance: these are auto-filled, NOT reads */}
              {requiredExts.length > 0 && (
                <div className="rounded border border-amber-700/40 bg-amber-900/15 p-1.5 space-y-1">
                  <div className="text-[11px] font-medium text-amber-300">Required inputs</div>
                  {requiredExts.map((ext, i) => {
                    const props = ext.params.properties
                    const names = props && typeof props === 'object' ? Object.keys(props) : []
                    const req = Array.isArray(ext.params.required) ? ext.params.required : []
                    return (
                      <div key={ext.uri || i} className="flex flex-wrap items-center gap-1">
                        {names.map((p) => (
                          <span key={p} className="rounded bg-amber-500/15 border border-amber-600/40 px-1.5 py-0.5 text-[10px] text-amber-200">
                            {p}{req.includes(p) ? ' *' : ''}
                          </span>
                        ))}
                      </div>
                    )
                  })}
                  <div className="text-[10px] text-slate-400 leading-snug">
                    Auto-extracted from the run prompt and sent for you — don't add these as reads.
                  </div>
                </div>
              )}

              {/* Skills — collapsed; the examples hint at what the agent expects */}
              {skills.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[11px] text-cyan-300">
                    {skills.length} skill{skills.length === 1 ? '' : 's'}
                  </summary>
                  <div className="mt-1 space-y-1.5">
                    {skills.map((skill, i) => (
                      <div key={skill.id || i} className="rounded bg-slate-800/60 p-1.5">
                        <div className="text-[11px] text-slate-200">{skill.name || skill.id}</div>
                        {skill.description && (
                          <div className="text-[10px] text-slate-400 leading-snug">{skill.description}</div>
                        )}
                        {Array.isArray(skill.examples) && skill.examples.length > 0 && (
                          <div className="mt-1 text-[10px] text-slate-500 italic truncate">
                            e.g. “{skill.examples[0]}”
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Poll interval (seconds)</label>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={form.a2a_poll_interval_seconds ?? 1}
            onChange={(e) => onChange('a2a_poll_interval_seconds', e.target.value)}
            disabled={disabled}
            className={`${inputCls} ${pollIssue ? 'border-red-500' : ''}`}
          />
          {pollIssue && <p className="mt-1 text-[10px] text-red-400">{pollIssue.short}</p>}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Task timeout (seconds)</label>
          <input
            type="number"
            min="1"
            step="1"
            value={form.a2a_task_timeout_seconds ?? 3600}
            onChange={(e) => onChange('a2a_task_timeout_seconds', e.target.value)}
            disabled={disabled}
            className={`${inputCls} ${timeoutIssue ? 'border-red-500' : ''}`}
          />
          {timeoutIssue && <p className="mt-1 text-[10px] text-red-400">{timeoutIssue.short}</p>}
        </div>
      </div>

      {/* Reads */}
      <div className="space-y-2">
        <div>
          <label className="block text-xs font-medium text-slate-400">Reads (agent inputs)</label>
          <p className="text-[11px] text-slate-500 leading-snug">
            Each read pulls one workflow value and sends it to the agent. Pick the <span className="text-slate-400">source</span> (a key that exists in the run); the <span className="text-slate-400">label</span> is the name the agent sees — leave it blank to reuse the source name, or set it (e.g. <code className="text-slate-400">request</code>) when the agent expects a specific field.
          </p>
        </div>
        {reads.map((r, idx) => (
          <div key={idx} className="rounded border border-slate-700 bg-slate-800/40 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Read {idx + 1}</span>
              <button
                type="button"
                onClick={() => removeRead(idx)}
                disabled={disabled}
                className="p-0.5 text-slate-500 hover:text-red-400 disabled:opacity-50"
                title="Remove read"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-0.5">Source — workflow context key</label>
              <input
                type="text"
                list={CONTEXT_KEY_DATALIST_ID}
                value={r.context_key || ''}
                onChange={(e) => updateRead(idx, { context_key: e.target.value })}
                disabled={disabled}
                placeholder="e.g. user_prompt"
                className={rowInputCls}
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-0.5">Send as — label the agent sees</label>
              <input
                type="text"
                value={r.key || ''}
                onChange={(e) => updateRead(idx, { key: e.target.value })}
                disabled={disabled}
                placeholder={r.context_key ? `defaults to "${r.context_key}"` : 'defaults to the source key'}
                className={rowInputCls}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-slate-500">As</label>
              <select
                value={r.part || 'text'}
                onChange={(e) => updateRead(idx, { part: e.target.value })}
                disabled={disabled}
                className="px-1.5 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-50"
              >
                {PART_OPTIONS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <span className="text-[10px] text-slate-600">{r.part === 'data' ? 'structured data part' : 'text line'}</span>
            </div>
          </div>
        ))}
        {/* Shared by every source input above; native combobox = suggestions + free text. */}
        <datalist id={CONTEXT_KEY_DATALIST_ID}>
          {(contextKeyOptions || []).map((o) => (
            <option key={o.key} value={o.key} label={o.source} />
          ))}
        </datalist>
        <button
          type="button"
          onClick={addRead}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
        >
          <Plus className="w-3 h-3" /> Add read
        </button>
      </div>

      {/* Writes */}
      <div className="space-y-2">
        <div>
          <label className="block text-xs font-medium text-slate-400">Writes (required outputs)</label>
          <p className="text-[11px] text-slate-500 leading-snug">
            Each write captures an artifact the agent returns and stores it under a context key for downstream nodes. Leave empty if the node only sends a message.
          </p>
        </div>
        {writes.map((w, idx) => (
          <div key={idx} className="rounded border border-slate-700 bg-slate-800/40 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Write {idx + 1}</span>
              <button
                type="button"
                onClick={() => removeWrite(idx)}
                disabled={disabled}
                className="p-0.5 text-slate-500 hover:text-red-400 disabled:opacity-50"
                title="Remove write"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-0.5">Artifact name (from the agent's reply)</label>
              <input
                type="text"
                value={w.artifact_name || ''}
                onChange={(e) => updateWrite(idx, { artifact_name: e.target.value })}
                disabled={disabled}
                placeholder="e.g. restriction"
                className={rowInputCls}
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-0.5">Store as — context key</label>
              <input
                type="text"
                value={w.context_key || ''}
                onChange={(e) => updateWrite(idx, { context_key: e.target.value })}
                disabled={disabled}
                placeholder={w.artifact_name ? `defaults to "${w.artifact_name}"` : 'defaults to the artifact name'}
                className={rowInputCls}
              />
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={w.required === true}
                onChange={(e) => updateWrite(idx, { required: e.target.checked })}
                disabled={disabled}
                className="rounded border-slate-500 bg-slate-700 text-cyan-500 focus:ring-cyan-500 disabled:opacity-50"
              />
              Required — fail the node if the agent doesn't return it
            </label>
          </div>
        ))}
        <button
          type="button"
          onClick={addWrite}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
        >
          <Plus className="w-3 h-3" /> Add write
        </button>
      </div>
    </>
  )
}
