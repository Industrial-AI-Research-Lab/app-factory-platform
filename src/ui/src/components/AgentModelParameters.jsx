import { useEffect, useState } from 'react'
import ModelPicker from './ModelPicker'
import { apiFetch, formatApiDetail } from '../utils_api'
import {
  getAgentModelChangeFields,
  getReasoningControlMode,
  getReasoningEffortOptions,
  getTemperatureControlState,
} from '../pages/agentConfigurationState'

const Field = ({ label, children }) => (
  <label className="block">
    <span className="block text-xs text-slate-400 mb-1">{label}</span>
    {children}
  </label>
)

const modelConfigPath = (model) => String(model)
  .split('/')
  .map(encodeURIComponent)
  .join('/')

export default function AgentModelParameters({ agent, agentKey, onChange, onChangeMany }) {
  const [config, setConfig] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setConfig(null)
    setError('')
    if (!agent.model) return () => controller.abort()

    apiFetch('/settings/model-config/' + modelConfigPath(agent.model), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(formatApiDetail(payload.detail))
        }
        return response.json()
      })
      .then((nextConfig) => {
        if (controller.signal.aborted) return
        setConfig(nextConfig)
      })
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') setError(requestError.message)
      })

    return () => controller.abort()
  }, [agent.model])

  const temperature = config?.temperature
  const forcedTemperature = temperature?.forced
  const minTemperature = temperature?.min ?? 0
  const maxTemperature = temperature?.max ?? 2
  const temperatureControl = getTemperatureControlState(
    temperature,
    agent.temperature,
  )
  const reasoning = config?.reasoning
  const controlMode = getReasoningControlMode(reasoning)
  const reasoningEfforts = getReasoningEffortOptions(reasoning)
  const selectedEffort = agent.reasoning_effort || ''
  const selectedEffortIsUnsupported = Boolean(
    selectedEffort && !reasoningEfforts.includes(selectedEffort),
  )
  const showReasoning = controlMode !== 'hidden' || Boolean(selectedEffort)
  const useEffortSelect = controlMode === 'effort-select' || controlMode === 'hidden'
  const defaultEffortLabel = reasoning?.default_effort
    ? `Use model default (${reasoning.default_effort})`
    : 'Use model default'
  return (
    <>
      <Field label="Model">
        <ModelPicker
          value={agent.model}
          onChange={(value) => {
            const fields = getAgentModelChangeFields(value)
            if (onChangeMany) onChangeMany(agentKey, fields)
            else {
              onChange(agentKey, 'model', fields.model)
              onChange(agentKey, 'temperature', fields.temperature)
            }
          }}
        />
      </Field>
      <Field label={'Temperature: ' + (agent.temperature ?? 'model default')}>
        <input
          type="range"
          min={forcedTemperature ?? minTemperature}
          max={forcedTemperature ?? maxTemperature}
          step="0.1"
          value={temperatureControl.displayValue}
          disabled={temperatureControl.disabled}
          onChange={(event) => onChange(agentKey, 'temperature', Number(event.target.value))}
          className="w-full accent-blue-500 disabled:opacity-50"
        />
        {forcedTemperature != null && (
          <span className="text-[11px] text-slate-500">
            Fixed at {forcedTemperature} for this model
          </span>
        )}
        {temperatureControl.forcedMismatch && (
          <button
            type="button"
            onClick={() => onChange(agentKey, 'temperature', Number(forcedTemperature))}
            className="block text-[11px] text-blue-400 hover:text-blue-300"
          >
            Use required value
          </button>
        )}
        {temperature?.supported === false && (
          <span className="text-[11px] text-slate-500">
            This model does not support custom temperature
          </span>
        )}
        {temperatureControl.unsupportedValue && (
          <button
            type="button"
            onClick={() => onChange(agentKey, 'temperature', null)}
            className="block text-[11px] text-blue-400 hover:text-blue-300"
          >
            Use model default
          </button>
        )}
      </Field>
      {showReasoning && (
        <Field label="Reasoning Effort">
          {useEffortSelect ? (
            <>
              <select
                value={selectedEffort}
                onChange={(event) => onChange(agentKey, 'reasoning_effort', event.target.value || null)}
                disabled={!config}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm"
              >
                <option value="">{defaultEffortLabel}</option>
                {selectedEffortIsUnsupported && (
                  <option value={selectedEffort} disabled>
                    {selectedEffort} (not supported)
                  </option>
                )}
                {reasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>{effort}</option>
                ))}
              </select>
              {reasoning?.mandatory && (
                <span className="text-[11px] text-slate-500">
                  Reasoning is required by this model
                </span>
              )}
            </>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={Boolean(selectedEffort)}
                  disabled={!config}
                  onChange={(event) => onChange(
                    agentKey,
                    'reasoning_effort',
                    event.target.checked ? (reasoning?.default_effort || 'medium') : null,
                  )}
                  className="accent-blue-500"
                />
                Enable reasoning
              </label>
              <span className="text-[11px] text-slate-500">
                This model exposes no effort selector — using a best-effort default
              </span>
            </>
          )}
        </Field>
      )}
      {error && <p className="col-span-full text-xs text-red-400">{error}</p>}
    </>
  )
}
