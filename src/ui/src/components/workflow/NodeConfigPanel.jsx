import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { X, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import ChipInput from '../ChipInput'
import A2aNodeFields from './A2aNodeFields'
import ToolNodeFields from './ToolNodeFields'
import MapNodeFields from './MapNodeFields'
import Editor from '@monaco-editor/react'
import {
  FULL_CONTEXT_READS_TOKEN,
  READ_KEY_SUGGESTIONS,
  WORKFLOW_DEFAULT_READS_TOKEN,
  WRITE_KEY_SUGGESTIONS,
  collectContextKeyOptions,
  mergeContractKeys,
  normalizeContractKeyList,
  withoutKeys,
} from '../../utils/workflow_serializer'
import { getNodeValidationIssues } from '../../utils/workflow_validation'

const NODE_TYPE_FIELDS = {
  start: [],
  end: [],
  // phase has no 'label': Phase Label doubles as the display name (merged).
  phase: ['task_type', 'description', 'agent_selection', 'agent_type', 'phase_label', 'reads', 'writes', 'can_delegate', 'max_retries', 'output_schema', 'reviewers'],
  approval_gate: ['label', 'description', 'interaction_schema'],
  execution: ['label', 'description'],
  deploy: ['label', 'description'],
  // a2a_agent renders label/description here; server_id + structured reads/writes are
  // handled by the dedicated A2aNodeFields block (those are dicts, not phase string keys).
  a2a_agent: ['label', 'description'],
  validator: ['label', 'checks'],
  // phase_label, operation, server, binding, reads and writes live in ToolNodeFields:
  // here the label is the display name, not a copy of the phase label.
  tool: ['label', 'description'],
  // A map node always picks its agent directly; phase_label and the map
  // settings live in MapNodeFields so the label stays the display name.
  map: ['label', 'description', 'agent_type', 'reads', 'writes', 'task_type'],
}

const TOOL_NODE_FORM_FIELDS = ['phase_label', 'operation', 'server', 'binding', 'reads', 'writes']
const MAP_NODE_FORM_FIELDS = [
  'phase_label', 'agent_selection', 'items_from', 'item_key', 'batch_size', 'concurrency',
  'max_item_attempts', 'item_checks',
]

const AGENT_SELECTION_OPTIONS = ['auction', 'direct']

// ⓘ popover copy. Plain-words explanations of what the runtime really does
// with each field — keep them jargon-free ("hire", "save key", not
// "delegate_to_agent tool exposure").
const FIELD_HINTS = {
  phase_label:
    "The phase's name. It shows on the canvas and in run progress, and each agent lists which phases it may join — that list is matched against this name. Required when you pick the agent yourself.",
  description:
    "Tell the agent what to do here, in plain words — this becomes its task. In auction mode bidding agents also read it to judge fit. With a hand-picked agent you may leave it empty: the agent then works from its own system prompt plus the previous phase's output.",
  agent_selection:
    'How the worker is chosen. Auction: every eligible agent looks at the task and the best fit wins. Direct: you pick the agent yourself, no contest.',
  agent_type:
    'The agent that runs this phase.',
  task_type:
    'A short machine name for this kind of work (e.g. gather_requirements). Bookkeeping: stamped on the task, shown in logs, and read by auction bidders. Empty = the node id is used.',
  writes:
    "Where this phase's result is stored so later phases can read it.",
  can_delegate:
    'Let this phase\'s agent hire other agents as helpers mid-task. Who it may hire is configured on the agent itself, not here.',
  max_retries:
    'Total attempts this phase gets before the workflow gives up — the first run counts. Empty = 3.',
  node_id:
    'Internal name of this node — how logs, error messages and saved workflow files refer to it. Fixed at creation.',
  output_schema:
    'JSON Schema describing the expected output of this phase. The agent must return an object matching this shape.',
  checks:
    'Deterministic format checks run against the shared project context. Array of {key, kind: "structural"|"json_schema", …} objects — all must pass to take the approved/default edge; any failure takes the rejected edge with feedback for the retrying phase.',
  item_checks:
    'Checks on each item answer, like a validator\'s. Array of {key, kind: "json_schema"|"value_relation", …}; key is "item" (the answer) or "item.<path>", and "map_item" names the input item. A failing item is retried with the failure as feedback.',
  max_reject_retries:
    'How many times this validator may reject and send the work back before the run gives up and fails. Bounds wasted retries below the workflow-wide iteration limit. Empty = no per-validator limit (only the workflow limit applies). 0 = fail on the first rejection.',
  reviewers:
    'Delegation reviewer config: per-target human or critic review wrapped around delegate_to_agent. Shape: {"targets": {"agent_id": {"human": "post"}}}.',
  interaction_schema:
    'Custom form definition for this approval gate. Lets reviewers take structured actions (remove tasks, add feedback) instead of a free-form approve/reject.',
}

function FieldLabel({ text, hint }) {
  return (
    <div className="relative mb-1 flex items-center gap-1.5">
      <label className="block text-xs font-medium text-slate-400">{text}</label>
      {hint && (
        <span className="group inline-flex">
          <span
            tabIndex={0}
            className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-500 text-[9px] leading-none text-slate-400 hover:border-blue-400 hover:text-blue-300 focus:outline-none"
          >
            i
          </span>
          <span className="pointer-events-none absolute left-0 right-0 top-full z-50 mt-1 hidden rounded-md border border-slate-600 bg-slate-900 p-2 text-[11px] font-normal text-slate-200 shadow-xl group-hover:block group-focus-within:block">
            {hint}
          </span>
        </span>
      )}
    </div>
  )
}

function FieldErrors({ issues }) {
  if (!issues.length) return null
  return issues.map(issue => (
    <div
      key={issue.message}
      className="mt-1.5 rounded border border-red-700/50 bg-red-900/30 p-2 text-xs text-red-300"
    >
      {issue.short || issue.message}
    </div>
  ))
}

function normalizePhaseValue(value) {
  return String(value || '').trim().toLowerCase()
}

function hasField(obj, field) {
  return Object.prototype.hasOwnProperty.call(obj || {}, field) && obj[field] != null
}

function getReadsMode(form) {
  if (!hasField(form, 'reads')) return 'inherit'
  const reads = normalizeContractKeyList(form.reads)
  if (reads.length === 0) return 'none'
  if (reads.includes(FULL_CONTEXT_READS_TOKEN)) return 'full'
  if (reads.includes(WORKFLOW_DEFAULT_READS_TOKEN)) return 'default_extra'
  return 'custom'
}

function describeEffectiveReads(mode, reads, workflowDefaultReads) {
  if (mode === 'inherit') {
    if (workflowDefaultReads == null) return 'legacy full context dump'
    const defaults = normalizeContractKeyList(workflowDefaultReads)
    if (defaults.length === 0) return 'no context'
    if (defaults.includes(FULL_CONTEXT_READS_TOKEN)) return 'all available workflow context'
    return defaults.join(', ')
  }
  if (mode === 'full') return 'all available workflow context'
  if (mode === 'none') return 'no context'

  const keys = mode === 'default_extra'
    ? mergeContractKeys(workflowDefaultReads || [], reads.filter(key => key !== WORKFLOW_DEFAULT_READS_TOKEN))
    : reads
  if (keys.includes(FULL_CONTEXT_READS_TOKEN)) return 'all available workflow context'
  return keys.length > 0 ? keys.join(', ') : 'no context'
}

function getEffectiveReadsDetails(mode, reads, workflowDefaultReads) {
  const text = describeEffectiveReads(mode, reads, workflowDefaultReads)
  if (
    text === 'legacy full context dump' ||
    text === 'all available workflow context' ||
    text === 'no context'
  ) {
    const badgeByText = {
      'legacy full context dump': 'Legacy full',
      'all available workflow context': 'Full context',
      'no context': 'No context',
    }
    return {
      badge: badgeByText[text],
      keys: [],
      text,
    }
  }

  const keys = text.split(',').map(key => key.trim()).filter(Boolean)
  return {
    badge: `${keys.length} key${keys.length === 1 ? '' : 's'}`,
    keys,
    text,
  }
}

function getWorkflowDefaultReadState(workflowDefaultReads, workflowDefaultMode) {
  if (['legacy', 'full', 'none'].includes(workflowDefaultMode)) {
    return workflowDefaultMode
  }
  if (workflowDefaultReads == null) return 'legacy'
  const defaults = normalizeContractKeyList(workflowDefaultReads)
  if (defaults.includes(FULL_CONTEXT_READS_TOKEN)) return 'full'
  if (defaults.length === 0) return 'none'
  return 'concrete'
}

function getSelectableReadsMode(mode, workflowDefaultReads, workflowDefaultMode) {
  if (mode !== 'default_extra') return mode
  const defaultState = getWorkflowDefaultReadState(workflowDefaultReads, workflowDefaultMode)
  if (defaultState === 'concrete') return mode
  if (defaultState === 'full') return 'full'
  if (defaultState === 'legacy') return 'inherit'
  return 'custom'
}

function ModeButton({ active, disabled, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-1 rounded border text-[11px] transition-colors disabled:opacity-50 ${
        active
          ? 'bg-blue-600/30 border-blue-500 text-blue-200'
          : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500'
      }`}
    >
      {children}
    </button>
  )
}

export const FIELD_SCHEMAS = {
  output_schema: { type: 'object', additionalProperties: true },
  checks: {
    type: 'array',
    items: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Context key path (e.g. "plan.tasks")' },
        kind: { type: 'string', enum: ['structural', 'json_schema'] },
        type: { type: 'string', enum: ['dict', 'array', 'string', 'number', 'bool'] },
        min_length: { type: 'integer', minimum: 0 },
        max_length: { type: 'integer', minimum: 0 },
        required_keys: { type: 'array', items: { type: 'string' } },
        json_schema: { type: 'object' },
      },
      additionalProperties: true,
    },
  },
  reviewers: {
    type: 'object',
    properties: {
      targets: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            human: { type: 'string', enum: ['post'] },
            critic: { type: 'array', items: { type: 'string', enum: ['pre', 'post'] } },
          },
        },
      },
      default: {
        type: 'object',
        properties: {
          human: { type: 'string', enum: ['post'] },
          critic: { type: 'array', items: { type: 'string', enum: ['pre', 'post'] } },
        },
      },
    },
  },
  interaction_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Schema type identifier' },
    },
    additionalProperties: true,
  },
}

const MONACO_MARKER_ERROR = 8
const MONACO_JSON_FIELD_HEIGHT = { collapsed: '120px', expanded: '360px' }

function registerFieldSchemas(monaco) {
  const fields = ['output_schema', 'checks', 'reviewers', 'interaction_schema']
  const schemas = fields.map(field => {
    const uri = `internal://node-field/${field}`
    return { uri, fileMatch: [uri], schema: FIELD_SCHEMAS[field] }
  })
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas,
    schemaValidation: 'error',
  })
}

export function jsonFieldTypeError(parsed, validateArray) {
  if (validateArray && !Array.isArray(parsed)) {
    return 'Expected a JSON array (e.g. [{ "key": "plan.tasks", "type": "array" }])'
  }
  if (!validateArray && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    return 'Expected a JSON object (e.g. { "type": "object", "properties": {} })'
  }
  return null
}

export function jsonFieldHasSchemaError(markers) {
  return (markers || []).some(marker => marker.severity === MONACO_MARKER_ERROR)
}

export function jsonFieldSchemaErrorMessage(markers) {
  const marker = (markers || []).find(item => item.severity === MONACO_MARKER_ERROR)
  return marker?.message || 'JSON does not match the field schema'
}

function schemaEnumError(value, schema) {
  if (!schema?.enum) return null
  // JSON null is an explicit value; Monaco rejects it for enum — sync must too
  if (value === null || !schema.enum.includes(value)) {
    return `Value is not accepted. Valid values: ${schema.enum.join(', ')}`
  }
  return null
}

function schemaPrimitiveError(value, schema) {
  if (!schema?.type) return null
  if (value === null) return `Expected ${schema.type}`

  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return 'Expected integer'
    }
    if (schema.minimum != null && value < schema.minimum) {
      return `Value must be >= ${schema.minimum}`
    }
    if (schema.maximum != null && value > schema.maximum) {
      return `Value must be <= ${schema.maximum}`
    }
    return null
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number') return 'Expected number'
    return null
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return 'Expected string'
    return null
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return 'Expected boolean'
    return null
  }

  return null
}

function validateAgainstSchema(value, schema) {
  if (!schema) return null

  const enumErr = schemaEnumError(value, schema)
  if (enumErr) return enumErr

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return 'Expected array'
    for (const item of value) {
      const err = validateAgainstSchema(item, schema.items)
      if (err) return err
    }
    return null
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 'Expected object'
    }
    if (schema.required) {
      for (const key of schema.required) {
        if (value[key] === undefined || value[key] === null || value[key] === '') {
          return `Missing required property '${key}'`
        }
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) {
        const err = validateAgainstSchema(value[key], propSchema)
        if (err) return err
      }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (schema.properties?.[key]) continue
        const err = validateAgainstSchema(nested, schema.additionalProperties)
        if (err) return err
      }
    }
    return null
  }

  return schemaPrimitiveError(value, schema)
}

export function jsonFieldSyncSchemaError(parsed, fieldKey) {
  if (parsed == null || !fieldKey) return null
  return validateAgainstSchema(parsed, FIELD_SCHEMAS[fieldKey])
}

export function jsonFieldKeyFromPath(path) {
  const prefix = 'internal://node-field/'
  return path?.startsWith(prefix) ? path.slice(prefix.length) : null
}

export function evaluateJsonFieldDraft(text, validateArray, schemaMarkers) {
  if (!text || !text.trim()) return { error: null, parsed: null }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'Invalid JSON syntax', parsed: null }
  }
  const typeError = jsonFieldTypeError(parsed, validateArray)
  if (typeError) return { error: typeError, parsed: null }
  if (jsonFieldHasSchemaError(schemaMarkers)) {
    return { error: jsonFieldSchemaErrorMessage(schemaMarkers), parsed: null }
  }
  return { error: null, parsed }
}

export function evaluateJsonFieldCommit(text, validateArray, schemaMarkers, fieldKey) {
  const result = evaluateJsonFieldDraft(text, validateArray, schemaMarkers)
  if (result.error) return result
  const syncErr = jsonFieldSyncSchemaError(result.parsed, fieldKey)
  if (syncErr) return { error: syncErr, parsed: null }
  return result
}

function syncDraftError(text, validateArray, fieldKey) {
  const result = evaluateJsonFieldDraft(text, validateArray, [])
  if (result.error) return result.error
  return jsonFieldSyncSchemaError(result.parsed, fieldKey)
}

function MonacoJsonField({
  value, onChange, disabled, path, validateArray, onBeforeMount, onErrorChange,
}) {
  const fieldKey = jsonFieldKeyFromPath(path)
  const serialized = value == null ? '' : JSON.stringify(value, null, 2)
  const [fieldError, setFieldError] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const draftRef = useRef(serialized)

  // Ref for onErrorChange: parent passes an inline callback whose setState makes a
  // new object each render — taking it as a dep loops forever (PluginsCard pattern).
  const onErrorChangeRef = useRef(onErrorChange)
  useEffect(() => {
    onErrorChangeRef.current = onErrorChange
  })
  useEffect(() => {
    onErrorChangeRef.current?.(fieldError)
  }, [fieldError])
  // Clear sticky Save gate when this editor unmounts (e.g. Advanced collapse)
  useEffect(() => () => onErrorChangeRef.current?.(null), [])

  const handleEditorChange = (text) => {
    const next = text ?? ''
    draftRef.current = next
    if (!next.trim()) {
      setFieldError(null)
      onChange(null)
      return
    }
    const syncErr = syncDraftError(next, validateArray, fieldKey)
    setFieldError(syncErr)
    if (syncErr) return
    const { parsed } = evaluateJsonFieldDraft(next, validateArray, [])
    onChange(parsed)
  }

  const handleValidate = (markers) => {
    // PluginsCard: onValidate only drives schema error / Save gate — never parent write
    // (async markers after a sibling-field edit would otherwise overwrite the whole form).
    const text = draftRef.current
    if (!text.trim()) {
      setFieldError(null)
      return
    }
    const { error } = evaluateJsonFieldCommit(text, validateArray, markers, fieldKey)
    setFieldError(error)
  }

  const editorHeight = expanded ? MONACO_JSON_FIELD_HEIGHT.expanded : MONACO_JSON_FIELD_HEIGHT.collapsed

  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          disabled={disabled}
          className="text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-50"
        >
          {expanded ? 'Collapse editor' : 'Expand editor'}
        </button>
      </div>
      <div
        className={`rounded border ${fieldError ? 'border-red-600' : 'border-slate-600'}`}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Editor
          height={editorHeight}
          language="json"
          theme="AppFactory-dark"
          defaultValue={serialized}
          path={path}
          onMount={(_editor, monaco) => onBeforeMount?.(monaco)}
          onChange={handleEditorChange}
          onValidate={handleValidate}
          beforeMount={(monaco) => onBeforeMount?.(monaco)}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbers: 'off',
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            readOnly: disabled,
            folding: false,
            glyphMargin: false,
            lineDecorationsWidth: 4,
            lineNumbersMinChars: 0,
            tabSize: 2,
            insertSpaces: true,
            fixedOverflowWidgets: true,
          }}
        />
      </div>
      {fieldError && (
        <div className="mt-1.5 rounded border border-red-700/50 bg-red-900/30 p-2 text-xs text-red-300">
          {fieldError}
        </div>
      )}
    </div>
  )
}

export default function NodeConfigPanel({
  node,
  agents,
  a2aServers,
  allNodes,
  workflowDefaultReads,
  workflowDefaultMode,
  workflowExecutionMode = 'dynamic',
  onUpdate,
  onClose,
  onSwitchToJson,
  onJsonFieldErrorChange,
}) {


  const [form, setForm] = useState({})
  const [readsModeOverride, setReadsModeOverride] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [formNodeId, setFormNodeId] = useState(null)
  const [jsonFieldErrors, setJsonFieldErrors] = useState({})

  const reportJsonFieldError = (field) => (error) => {
    setJsonFieldErrors(prev => (prev[field] === error ? prev : { ...prev, [field]: error }))
  }

  const onJsonFieldErrorChangeRef = useRef(onJsonFieldErrorChange)
  useEffect(() => {
    onJsonFieldErrorChangeRef.current = onJsonFieldErrorChange
  })
  useEffect(() => {
    const msgs = Object.values(jsonFieldErrors).filter(Boolean)
    onJsonFieldErrorChangeRef.current?.(msgs.length ? msgs.join('; ') : null)
  }, [jsonFieldErrors])
  useEffect(() => () => onJsonFieldErrorChangeRef.current?.(null), [])


  const handleMonacoBeforeMount = (monaco) => {
    monaco.editor.defineTheme('AppFactory-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editorSuggestWidget.background': '#252526',
        'editorSuggestWidget.border': '#454545',
        'editorSuggestWidget.foreground': '#d4d4d4',
        'editorSuggestWidget.selectedBackground': '#04395e',
        'editorSuggestWidget.selectedForeground': '#ffffff',
        'editorSuggestWidget.highlightForeground': '#18a3ff',
        'editorSuggestWidget.focusHighlightForeground': '#18a3ff',
      },
    })
    registerFieldSchemas(monaco)
  }


  if (node && formNodeId !== node.id) {
    setFormNodeId(node.id)
    setForm({ ...node.data })
    setReadsModeOverride(null)
    setShowAdvanced(false)
    setJsonFieldErrors({})
  }

  useEffect(() => {
    if (!node) return

    const reads = normalizeContractKeyList(form.reads)
    if (!reads.includes(WORKFLOW_DEFAULT_READS_TOKEN)) return

    const mode = getSelectableReadsMode(
      'default_extra',
      workflowDefaultReads,
      workflowDefaultMode,
    )
    if (mode === 'default_extra') return

    const extraReads = reads.filter(
      key => key !== WORKFLOW_DEFAULT_READS_TOKEN && key !== FULL_CONTEXT_READS_TOKEN
    )
    const updated = { ...form }
    if (mode === 'inherit') {
      delete updated.reads
    } else if (mode === 'full') {
      updated.reads = [FULL_CONTEXT_READS_TOKEN]
    } else {
      updated.reads = extraReads
    }

    setReadsModeOverride(mode)
    setForm(updated)
    onUpdate(node.id, updated)
  }, [workflowDefaultMode, workflowDefaultReads])

  if (!node) return null

  const nodeType = node.data?.nodeType || node.type
  const fields = NODE_TYPE_FIELDS[nodeType] || []
  const isSystemWorkflow = node.data?._isSystem

  const handleChange = (field, value) => {
    const updated = { ...form, [field]: value }
    setForm(updated)
    onUpdate(node.id, updated)
  }

  // Phase Label doubles as the canvas title (Label was merged into it) —
  // keep data.label in sync so every node renderer stays label-driven.
  const handlePhaseLabelChange = (value) => {
    const updated = { ...form, phase_label: value, label: value }
    setForm(updated)
    onUpdate(node.id, updated)
  }

  const handleKeyListChange = (field, value) => {
    handleChange(field, normalizeContractKeyList(value))
  }

  const handleReadsModeChange = (requestedMode) => {
    const mode = getSelectableReadsMode(
      requestedMode,
      workflowDefaultReads,
      workflowDefaultMode,
    )
    setReadsModeOverride(mode)
    const currentKeys = normalizeContractKeyList(form.reads)
      .filter(key => key !== FULL_CONTEXT_READS_TOKEN && key !== WORKFLOW_DEFAULT_READS_TOKEN)
    if (mode === 'inherit') {
      handleChange('reads', undefined)
    } else if (mode === 'none') {
      handleKeyListChange('reads', [])
    } else if (mode === 'full') {
      handleKeyListChange('reads', [FULL_CONTEXT_READS_TOKEN])
    } else if (mode === 'default_extra') {
      handleKeyListChange('reads', [
        WORKFLOW_DEFAULT_READS_TOKEN,
        ...withoutKeys(currentKeys, workflowDefaultReads || []),
      ])
    } else {
      handleKeyListChange('reads', currentKeys)
    }
  }

  const handleReadsKeysChange = (values) => {
    const readsMode = getSelectableReadsMode(
      readsModeOverride ?? getReadsMode(form),
      workflowDefaultReads,
      workflowDefaultMode,
    )
    if (readsMode === 'default_extra') {
      handleKeyListChange('reads', [
        WORKFLOW_DEFAULT_READS_TOKEN,
        ...withoutKeys(values, workflowDefaultReads || []),
      ])
      return
    }
    handleKeyListChange('reads', values)
  }

  const handleMaxRetriesChange = (value) => {
    if (value === '') {
      handleChange('max_retries', undefined)
      return
    }
    const parsed = Number(value)
    if (Number.isInteger(parsed)) {
      handleChange('max_retries', parsed)
    }
  }

  const handleMaxRejectRetriesChange = (value) => {
    if (value === '') {
      handleChange('max_reject_retries', undefined)
      return
    }
    const parsed = Number(value)
    if (Number.isInteger(parsed)) {
      handleChange('max_reject_retries', parsed)
    }
  }

  const directAgentOptions = []
  const seenDirectAgentIds = new Set()

  for (const agent of (agents || [])) {
    const agentId = agent.id || agent._id || agent.agent_id
    if (agentId && !seenDirectAgentIds.has(agentId)) {
      seenDirectAgentIds.add(agentId)
      directAgentOptions.push({
        value: agentId,
        label: agent.name ? `${agentId} (${agent.name})` : agentId,
      })
    }
  }

  const selectedAgent = (agents || []).find(a => {
    const agentId = a.id || a._id || a.agent_id
    if (form.agent_selection === 'direct') {
      return agentId === form.agent_type
    }
    return (a.type || agentId) === form.agent_type
  })
  const selectedAgentPhases = Array.isArray(selectedAgent?.allowed_phases) ? selectedAgent.allowed_phases : []
  const effectivePhaseLabel = normalizePhaseValue(form.phase_label)
  const nodeValidationIssues = getNodeValidationIssues({ ...form, nodeType }, node.id)
  const issuesFor = (field) =>
    nodeValidationIssues.filter(issue => (issue.fields || []).includes(field))
  const renderedErrorFields = new Set([
    'task_type', 'description', 'agent_type', 'phase_label', 'reads', 'writes', 'max_retries',
    'operation', 'server', 'binding',
    'items_from', 'item_key', 'batch_size', 'concurrency', 'max_item_attempts',
  ])
  const unanchoredIssues = nodeValidationIssues.filter(
    issue => !(issue.fields || []).some(field => renderedErrorFields.has(field))
  )
  const PANEL_INTERNAL_KEYS = new Set(['nodeType', '_isSystem', 'label'])
  const controlledByPanel = new Set([
    ...fields,
    ...(nodeType === 'a2a_agent' ? ['server_id', 'reads', 'writes', 'a2a_poll_interval_seconds', 'a2a_task_timeout_seconds'] : []),
    ...(nodeType === 'tool' ? TOOL_NODE_FORM_FIELDS : []),
    ...(nodeType === 'map' ? MAP_NODE_FORM_FIELDS : []),
  ])
  const hiddenFields = Object.keys(form).filter(k => {
    if (controlledByPanel.has(k) || PANEL_INTERNAL_KEYS.has(k)) return false
    const v = form[k]
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
  })
  const inputBorder = (field) =>
    issuesFor(field).length
      ? 'border-red-500/70 ring-1 ring-red-500/40'
      : 'border-slate-600'
  const readsValues = normalizeContractKeyList(form.reads)
  const writesValues = normalizeContractKeyList(form.writes)
  const writesUnset = !hasField(form, 'writes')
  const rawReadsMode = readsModeOverride ?? getReadsMode(form)
  const workflowDefaultsCanBeExtended =
    getWorkflowDefaultReadState(workflowDefaultReads, workflowDefaultMode) === 'concrete'
  const readsMode = getSelectableReadsMode(rawReadsMode, workflowDefaultReads, workflowDefaultMode)
  const readsInputEnabled = readsMode === 'default_extra' || readsMode === 'custom'
  const readsExtraValues = readsValues.filter(
    key => key !== FULL_CONTEXT_READS_TOKEN && key !== WORKFLOW_DEFAULT_READS_TOKEN
  )
  const editableReadsValues = !readsInputEnabled
    ? []
    : rawReadsMode === 'default_extra'
      ? withoutKeys(readsExtraValues, workflowDefaultReads || [])
      : readsValues
  const readSuggestions = readsMode === 'default_extra'
    ? withoutKeys(READ_KEY_SUGGESTIONS, workflowDefaultReads || [])
    : READ_KEY_SUGGESTIONS
  const readsForDescription = rawReadsMode === 'default_extra' && readsMode === 'custom'
    ? readsExtraValues
    : readsValues
  const effectiveReadsDetails = getEffectiveReadsDetails(
    readsMode,
    readsForDescription,
    workflowDefaultReads,
  )
  const isDirectOverride =
    form.agent_selection === 'direct' &&
    !!form.agent_type &&
    !!effectivePhaseLabel &&
    selectedAgentPhases.length > 0 &&
    !selectedAgentPhases.some(phase => normalizePhaseValue(phase) === effectivePhaseLabel)

  const isPhase = nodeType === 'phase'
  const isDirect = form.agent_selection === 'direct'
  const selectedAgentName = selectedAgent?.name || form.agent_type || ''

  // Legacy/imported phase nodes keep their name in `label`, not `phase_label`;
  // seed from it so the field isn't misleadingly blank (the canvas already shows
  // the name) and an edit preserves it. Skip label===id so a new node's auto-id
  // never seeds the field. Note: this only sets the displayed value — form.phase_label
  // stays empty until an edit, so workflow_serializer's keepLegacyPhaseName still holds.
  const phaseLabelValue =
    form.phase_label || (form.label && form.label !== node.id ? form.label : '')

  // "Agent default" writes: what actually happens if this node declares nothing.
  const agentDefaultWriteHint = (() => {
    if (!isDirect) return "the winning agent's own save key decides where the result goes."
    if (!selectedAgent) return 'pick an agent first — its own save key decides where the result goes.'
    return selectedAgent.output_save_key
      ? `result is saved as "${selectedAgent.output_save_key}" (${selectedAgentName}'s own save key).`
      : `nothing is saved — ${selectedAgentName} has no save key configured.`
  })()

  // Delegation is a 3-key chain (node switch + agent has the tool + agent has
  // a hire-list). The runtime hides the tool silently when a link is missing —
  // surface the dead link here instead.
  const delegationStatus = (() => {
    if (!isDirect) {
      return { tone: 'info', text: 'Applies to whichever agent wins this phase — that agent\'s own hire-list decides who it may hire.' }
    }
    if (!selectedAgent) {
      return { tone: 'info', text: 'Pick an agent first — its hire-list decides who it may hire.' }
    }
    const tools = selectedAgent.allowed_tools || []
    if (!tools.includes('delegate_to_agent')) {
      return { tone: 'warn', text: `${selectedAgentName} doesn't have the delegate_to_agent tool, so this switch does nothing. Add the tool in the agent editor.` }
    }
    const targets = (selectedAgent.allowed_delegation_targets || [])
      .map(t => String(t || '').trim())
      .filter(Boolean)
    if (targets.length === 0) {
      return { tone: 'warn', text: `${selectedAgentName} has an empty "Allowed Delegation Targets" list, so it can't hire anyone yet. Set targets in the agent editor.` }
    }
    if (targets.includes('*')) {
      return { tone: 'ok', text: `${selectedAgentName} may hire any agent in this tenant (plus system agents).` }
    }
    return { tone: 'ok', text: `${selectedAgentName} may hire: ${targets.join(', ')}` }
  })()

  // The task_type/description either-or issue renders under Description
  // (always visible) — only task_type-specific issues belong in Advanced.
  const taskTypeOnlyIssues = issuesFor('task_type').filter(
    issue => !(issue.fields || []).includes('description')
  )
  const advancedIssues = [...taskTypeOnlyIssues, ...issuesFor('max_retries')]
  // PluginsCard: keep section open while its JSON field still has an error
  const advancedJsonError = Boolean(jsonFieldErrors.output_schema || jsonFieldErrors.reviewers)
  const advancedOpen = showAdvanced || advancedIssues.length > 0 || advancedJsonError

  return (
    <div className="w-[300px] bg-slate-800 border-l border-slate-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Node Properties</h3>
          <span className="text-xs text-slate-400 capitalize">{nodeType}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-200 rounded"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* ID (read-only; for phase nodes it lives under Advanced) */}
        {!isPhase && (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Node ID</label>
            <input
              type="text"
              value={node.id}
              readOnly
              className="w-full px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-sm text-slate-400 cursor-not-allowed"
            />
          </div>
        )}

        {fields.includes('label') && (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Label</label>
            <input
              type="text"
              value={form.label || ''}
              onChange={(e) => handleChange('label', e.target.value)}
              disabled={isSystemWorkflow}
              className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              placeholder="Display label"
            />
          </div>
        )}

        {fields.includes('phase_label') && (
          <div>
            <FieldLabel text="Phase Label" hint={FIELD_HINTS.phase_label} />
            <input
              type="text"
              value={phaseLabelValue}
              onChange={(e) => handlePhaseLabelChange(e.target.value)}
              disabled={isSystemWorkflow}
              className={`w-full px-2 py-1.5 bg-slate-700 border ${inputBorder('phase_label')} rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50`}
              placeholder="e.g. Requirements Gathering"
            />
            <FieldErrors issues={issuesFor('phase_label')} />
          </div>
        )}

        {fields.includes('description') && (
          <div>
            <FieldLabel text="Description" hint={FIELD_HINTS.description} />
            <textarea
              value={form.description || ''}
              onChange={(e) => handleChange('description', e.target.value)}
              disabled={isSystemWorkflow}
              rows={3}
              className={`w-full px-2 py-1.5 bg-slate-700 border ${inputBorder('description')} rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none disabled:opacity-50`}
              placeholder={isPhase ? 'What should happen in this phase...' : 'What this node does...'}
            />
            {/* The task_type/description either-or rule anchors to both fields;
                show it here (always visible) and not under Task Type, which sits
                inside the collapsed Advanced section. */}
            <FieldErrors issues={issuesFor('description')} />
          </div>
        )}

        {fields.includes('interaction_schema') && (
          <div>
            <FieldLabel text="Interaction Schema" hint={FIELD_HINTS.interaction_schema} />
            <MonacoJsonField
              key={node.id + '-interaction_schema'}
              value={form.interaction_schema}
              onChange={(val) => handleChange('interaction_schema', val)}
              disabled={isSystemWorkflow}
              path="internal://node-field/interaction_schema"
              onBeforeMount={handleMonacoBeforeMount}
              onErrorChange={reportJsonFieldError('interaction_schema')}
            />
          </div>
        )}

        {nodeType === 'a2a_agent' && (
          <A2aNodeFields
            form={form}
            servers={a2aServers}
            contextKeyOptions={collectContextKeyOptions(allNodes, node.id)}
            onChange={handleChange}
            disabled={isSystemWorkflow}
            validationIssues={nodeValidationIssues}
          />
        )}

        {nodeType === 'tool' && (
          <ToolNodeFields
            form={form}
            onChange={handleChange}
            disabled={isSystemWorkflow}
            validationIssues={nodeValidationIssues}
          />
        )}

        {nodeType === 'map' && (
          <>
            <MapNodeFields
              form={form}
              onChange={handleChange}
              disabled={isSystemWorkflow}
              validationIssues={nodeValidationIssues}
            />
            <div>
              <FieldLabel text="Item Checks" hint={FIELD_HINTS.item_checks} />
              <MonacoJsonField
                key={node.id + '-item_checks'}
                value={form.item_checks}
                onChange={(val) => handleChange('item_checks', val)}
                disabled={isSystemWorkflow}
                path="internal://node-field/item_checks"
                validateArray
                onBeforeMount={handleMonacoBeforeMount}
                onErrorChange={reportJsonFieldError('item_checks')}
              />
            </div>
          </>
        )}

        {nodeType === 'validator' && (
          <>
            <div>
              <FieldLabel text="Checks" hint={FIELD_HINTS.checks} />
              <MonacoJsonField
                key={node.id + '-checks'}
                value={form.checks}
                onChange={(val) => handleChange('checks', val)}
                disabled={isSystemWorkflow}
                path="internal://node-field/checks"
                validateArray
                onBeforeMount={handleMonacoBeforeMount}
                onErrorChange={reportJsonFieldError('checks')}
              />
            </div>
            <div>
              <FieldLabel text="Max Reject Retries" hint={FIELD_HINTS.max_reject_retries} />
              <input
                type="number"
                min="0"
                max="10"
                step="1"
                value={form.max_reject_retries ?? ''}
                onChange={(e) => handleMaxRejectRetriesChange(e.target.value)}
                disabled={isSystemWorkflow}
                className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                placeholder="no limit"
              />
            </div>
          </>
        )}

        {fields.includes('agent_selection') && (
          <div>
            <FieldLabel text="Agent Selection" hint={FIELD_HINTS.agent_selection} />
            <select
              value={form.agent_selection || 'auction'}
              onChange={(e) => handleChange('agent_selection', e.target.value)}
              disabled={isSystemWorkflow}
              className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {AGENT_SELECTION_OPTIONS.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
        )}

        {/* Agent Type only matters for direct selection — the engine ignores
            it in auction mode, so don't render a dead dropdown there. */}
        {fields.includes('agent_type') && isDirect && (
          <div>
            <FieldLabel text="Agent Type" hint={FIELD_HINTS.agent_type} />
            <select
              value={form.agent_type || ''}
              onChange={(e) => handleChange('agent_type', e.target.value)}
              disabled={isSystemWorkflow}
              className={`w-full px-2 py-1.5 bg-slate-700 border ${inputBorder('agent_type')} rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50`}
            >
              <option value="">Select agent</option>
              {directAgentOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <Link
              to="/configurations/agents"
              target="_blank"
              className="inline-flex items-center gap-1 mt-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Manage agents
            </Link>
            {isDirectOverride && (
              <div className="mt-2 p-2 bg-orange-900/30 border border-orange-700/50 rounded text-xs text-orange-300">
                Override: {form.agent_type} normally participates in [{selectedAgentPhases.join(', ')}], not in "{effectivePhaseLabel}". Direct assignment overrides this.
              </div>
            )}
            <FieldErrors issues={issuesFor('agent_type')} />
          </div>
        )}

        {fields.includes('reads') && (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-400">Reads</label>
                <p className="text-[11px] text-slate-500">
                  Choose what context this phase receives in its initial prompt.
                </p>
              </div>
              <div className="group relative shrink-0">
                <button
                  type="button"
                  className="rounded border border-slate-600/80 bg-slate-900/60 px-1.5 py-0.5 text-[10px] font-medium text-blue-200 hover:border-blue-500/60 hover:bg-blue-950/40"
                >
                  Effective: {effectiveReadsDetails.badge}
                </button>
                <div className="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-64 rounded-md border border-slate-600 bg-slate-900 p-2 shadow-xl group-hover:block group-focus-within:block">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-300">
                    Effective reads
                  </div>
                  {effectiveReadsDetails.keys.length > 0 ? (
                    <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
                      {effectiveReadsDetails.keys.map(key => (
                        <span
                          key={key}
                          className="rounded border border-blue-500/30 bg-blue-950/40 px-1.5 py-0.5 text-[10px] text-blue-100"
                        >
                          {key}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-200">{effectiveReadsDetails.text}</div>
                  )}
                </div>
              </div>
            </div>
            <select
              value={readsMode}
              onChange={(e) => handleReadsModeChange(e.target.value)}
              disabled={isSystemWorkflow}
              className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="inherit">Inherit workflow defaults</option>
              {workflowDefaultsCanBeExtended && (
                <option value="default_extra">Workflow defaults + extra keys</option>
              )}
              <option value="custom">Custom keys only</option>
              <option value="full">Full context</option>
              <option value="none">No context</option>
            </select>
            {readsInputEnabled && (
              <ChipInput
                values={editableReadsValues}
                onChange={handleReadsKeysChange}
                suggestions={readSuggestions}
                placeholder="Add context keys"
                disabled={isSystemWorkflow}
              />
            )}
            <FieldErrors issues={issuesFor('reads')} />
          </div>
        )}

        {fields.includes('writes') && (
          <div className="space-y-2">
            <FieldLabel text="Writes" hint={FIELD_HINTS.writes} />
            <div className="flex flex-wrap gap-1.5">
              <ModeButton
                active={writesUnset}
                disabled={isSystemWorkflow}
                onClick={() => handleChange('writes', undefined)}
              >
                Agent default
              </ModeButton>
              <ModeButton
                active={!writesUnset && writesValues.length === 0}
                disabled={isSystemWorkflow}
                onClick={() => handleKeyListChange('writes', [])}
              >
                None
              </ModeButton>
            </div>
            {writesUnset && (
              <p className="text-[11px] text-slate-400">
                Effective: {agentDefaultWriteHint}
              </p>
            )}
            {!writesUnset && writesValues.length === 0 && (
              <p className="text-[11px] text-slate-400">
                Effective: nothing is saved for later phases.
              </p>
            )}
            <ChipInput
              values={writesValues}
              onChange={(values) => handleKeyListChange('writes', values)}
              suggestions={WRITE_KEY_SUGGESTIONS}
              placeholder="Or list exact keys the agent must fill"
              disabled={isSystemWorkflow}
            />
            {writesValues.length > 1 && (
              <div className="p-2 bg-amber-900/25 border border-amber-700/40 rounded text-[11px] text-amber-200">
                Multiple writes are not copied from one plain answer. The agent must return an object keyed by write name or call context_write for each extra key.
              </div>
            )}
            <FieldErrors issues={issuesFor('writes')} />
          </div>
        )}

        {isPhase && (
          <div className="border-t border-slate-700 pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex w-full items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
            >
              {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Advanced
            </button>
            {advancedOpen && (
              <div className="mt-3 space-y-4">
                <div>
                  <FieldLabel text="Node ID" hint={FIELD_HINTS.node_id} />
                  <input
                    type="text"
                    value={node.id}
                    readOnly
                    className="w-full px-2 py-1.5 bg-slate-700/50 border border-slate-600 rounded text-sm text-slate-400 cursor-not-allowed"
                  />
                </div>

                {fields.includes('task_type') && (
                  <div>
                    <FieldLabel text="Task Type" hint={FIELD_HINTS.task_type} />
                    <input
                      type="text"
                      value={form.task_type || ''}
                      onChange={(e) => handleChange('task_type', e.target.value)}
                      disabled={isSystemWorkflow}
                      className={`w-full px-2 py-1.5 bg-slate-700 border ${inputBorder('task_type')} rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50`}
                      placeholder={`Defaults to node id (${node.id})`}
                    />
                    <FieldErrors issues={taskTypeOnlyIssues} />
                  </div>
                )}

                {fields.includes('can_delegate') && (
                  <div className="p-2.5 bg-slate-700/30 border border-slate-600/50 rounded">
                    <label className="flex items-start gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={form.can_delegate === true}
                        onChange={(e) => handleChange('can_delegate', e.target.checked)}
                        disabled={isSystemWorkflow || workflowExecutionMode === 'static'}
                        className="mt-0.5 rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500 disabled:opacity-50"
                      />
                      <span>
                        <span className="block font-medium">Can Delegate</span>
                        <span className="block mt-0.5 text-[11px] text-slate-500">
                          {workflowExecutionMode === 'static'
                            ? 'Disabled for static workflows.'
                            : FIELD_HINTS.can_delegate}
                        </span>
                      </span>
                    </label>
                    {form.can_delegate === true && (
                      <div
                        className={`mt-2 rounded border p-2 text-[11px] ${
                          delegationStatus.tone === 'warn'
                            ? 'border-amber-700/40 bg-amber-900/25 text-amber-200'
                            : delegationStatus.tone === 'ok'
                              ? 'border-emerald-700/40 bg-emerald-900/20 text-emerald-200'
                              : 'border-slate-600/50 bg-slate-700/30 text-slate-300'
                        }`}
                      >
                        {delegationStatus.text}
                        {delegationStatus.tone === 'warn' && (
                          <Link
                            to="/configurations/agents"
                            target="_blank"
                            className="mt-1 flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            <ExternalLink className="w-3 h-3" />
                            Open agent editor
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {fields.includes('max_retries') && (
                  <div>
                    <FieldLabel text="Max Retries" hint={FIELD_HINTS.max_retries} />
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="1"
                      value={form.max_retries ?? ''}
                      onChange={(e) => handleMaxRetriesChange(e.target.value)}
                      disabled={isSystemWorkflow}
                      className={`w-full px-2 py-1.5 bg-slate-700 border ${inputBorder('max_retries')} rounded text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50`}
                      placeholder="3"
                    />
                    <FieldErrors issues={issuesFor('max_retries')} />
                  </div>
                )}

                {fields.includes('output_schema') && (
                  <div>
                    <FieldLabel text="Output Schema" hint={FIELD_HINTS.output_schema} />
                    <MonacoJsonField
                      key={node.id + '-output_schema'}
                      value={form.output_schema}
                      onChange={(val) => handleChange('output_schema', val)}
                      disabled={isSystemWorkflow}
                      path="internal://node-field/output_schema"
                      onBeforeMount={handleMonacoBeforeMount}
                      onErrorChange={reportJsonFieldError('output_schema')}
                    />
                  </div>
                )}

                {fields.includes('reviewers') && (
                  <div>
                    <FieldLabel text="Reviewers" hint={FIELD_HINTS.reviewers} />
                    <MonacoJsonField
                      key={node.id + '-reviewers'}
                      value={form.reviewers}
                      onChange={(val) => handleChange('reviewers', val)}
                      disabled={isSystemWorkflow}
                      path="internal://node-field/reviewers"
                      onBeforeMount={handleMonacoBeforeMount}
                      onErrorChange={reportJsonFieldError('reviewers')}
                    />
                  </div>
                )}
          </div>
            )}
          </div>
        )}

        {hiddenFields.length > 0 && (
          <div className="rounded border border-slate-600/60 bg-slate-700/30 px-3 py-2 text-[11px] text-slate-400">
            <span className="font-medium text-slate-300">Other fields: </span>
            {hiddenFields.map((k, i) => (
              <span key={k}>
                <span className="font-mono text-blue-300">{k}</span>
                {i < hiddenFields.length - 1 && <span>, </span>}
              </span>
            ))}
            {onSwitchToJson ? (
              <button
                type="button"
                onClick={onSwitchToJson}
                className="ml-1.5 underline text-blue-400 hover:text-blue-300 transition-colors"
              >
                view in JSON
              </button>
            ) : (
              <span className="ml-1">— switch to JSON mode to view or edit.</span>
            )}
          </div>
        )}

        {/* Rules whose field is not rendered for this node type still surface. */}
        <FieldErrors issues={unanchoredIssues} />


        {isSystemWorkflow && (
          <div className="p-2 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-300">
            System workflow - clone to edit
          </div>
        )}
      </div>
    </div>
  )
}
