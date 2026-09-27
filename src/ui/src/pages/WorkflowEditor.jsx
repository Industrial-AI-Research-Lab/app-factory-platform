import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
} from 'reactflow'
import 'reactflow/dist/style.css'

import StartNode from '../components/workflow/StartNode'
import EndNode from '../components/workflow/EndNode'
import PhaseNode from '../components/workflow/PhaseNode'
import ApprovalGateNode from '../components/workflow/ApprovalGateNode'
import ExecutionNode from '../components/workflow/ExecutionNode'
import DeployNode from '../components/workflow/DeployNode'
import A2aNode from '../components/workflow/A2aNode'
import ValidatorNode from '../components/workflow/ValidatorNode'
import ToolNode from '../components/workflow/ToolNode'
import MapNode from '../components/workflow/MapNode'
import ConditionalEdge from '../components/workflow/ConditionalEdge'
import NodeConfigPanel from '../components/workflow/NodeConfigPanel'
import TopNavLinks from '../components/TopNavLinks'
import ChipInput from '../components/ChipInput'

import {
  apiToReactFlow,
  applyNodeFormPatch,
  createNewNode,
  createEmptyWorkflow,
  FULL_CONTEXT_READS_TOKEN,
  READ_KEY_SUGGESTIONS,
  SYSTEM_BASE_READ_KEYS,
  WORKFLOW_DEFAULT_READS_TOKEN,
  normalizeContractKeyList,
  withoutKeys,
  mergeContractKeys,
  sanitizeWorkflowPrompts,
  getWorkflowPromptIssues,
  WORKFLOW_PROMPT_NAME_MAX_LEN,
  WORKFLOW_PROMPT_TEXT_MAX_LEN,
} from '../utils/workflow_serializer'
import { getWorkflowValidationErrors } from '../utils/workflow_validation'
import { apiFetch, formatApiDetail } from '../utils_api'
import {
  entityDescriptionsForForm,
  entityDescriptionsForSave,
  entityShortDescription,
  SHORT_DESCRIPTION_MAX_LEN,
} from '../utils/entity_descriptions'

import {
  Save,
  CheckCircle,
  AlertTriangle,
  Plus,
  Trash2,
  Copy,
  RefreshCw,
  ChevronDown,
  GripVertical,
  Play,
  Square,
  Layers,
  ShieldCheck,
  Zap,
  Rocket,
  Network,
  ListChecks,
  Wrench,
  Layers3,
} from 'lucide-react'

// Register custom node types
const nodeTypes = {
  startNode: StartNode,
  endNode: EndNode,
  phaseNode: PhaseNode,
  approvalGateNode: ApprovalGateNode,
  executionNode: ExecutionNode,
  deployNode: DeployNode,
  a2aNode: A2aNode,
  validatorNode: ValidatorNode,
  toolNode: ToolNode,
  mapNode: MapNode,
}

// Register custom edge types
const edgeTypes = {
  conditionalEdge: ConditionalEdge,
}

// Palette items for drag-and-drop
const PALETTE_ITEMS = [
  { type: 'start', label: 'Start', color: 'green', icon: Play },
  { type: 'phase', label: 'Phase', color: 'blue', icon: Layers },
  { type: 'approval_gate', label: 'Approval Gate', color: 'yellow', icon: ShieldCheck },
  { type: 'validator', label: 'Validator', color: 'teal', icon: ListChecks },
  { type: 'tool', label: 'Tool', color: 'indigo', icon: Wrench },
  { type: 'map', label: 'Map', color: 'pink', icon: Layers3 },
  { type: 'execution', label: 'Execution', color: 'purple', icon: Zap },
  { type: 'a2a_agent', label: 'A2A Agent', color: 'cyan', icon: Network },
  { type: 'deploy', label: 'Deploy', color: 'orange', icon: Rocket },
  { type: 'end', label: 'End', color: 'red', icon: Square },
]

const COLOR_MAP = {
  green: 'bg-green-900/50 border-green-500 text-green-300',
  blue: 'bg-blue-900/50 border-blue-500 text-blue-300',
  yellow: 'bg-yellow-900/50 border-yellow-500 text-yellow-300',
  purple: 'bg-purple-900/50 border-purple-500 text-purple-300',
  cyan: 'bg-cyan-900/50 border-cyan-500 text-cyan-300',
  orange: 'bg-orange-900/50 border-orange-500 text-orange-300',
  red: 'bg-red-900/50 border-red-500 text-red-300',
  teal: 'bg-teal-900/50 border-teal-500 text-teal-300',
  indigo: 'bg-indigo-900/50 border-indigo-500 text-indigo-300',
  pink: 'bg-pink-900/50 border-pink-500 text-pink-300',
}

function hasField(obj, field) {
  return Object.prototype.hasOwnProperty.call(obj || {}, field) && obj[field] != null
}

function getWorkflowDefaultMode(defaultReads) {
  if (defaultReads == null) return 'legacy'
  const reads = normalizeContractKeyList(defaultReads)
  if (reads.length === 0) return 'none'
  if (reads.length === 1 && reads[0] === FULL_CONTEXT_READS_TOKEN) return 'full'
  if (SYSTEM_BASE_READ_KEYS.every(key => reads.includes(key))) return 'system_base'
  return 'custom'
}

function normalizeNodeReadsForWorkflowDefaultMode(node, mode) {
  if (!['legacy', 'full', 'none'].includes(mode)) return node

  const reads = normalizeContractKeyList(node?.data?.reads)
  if (!reads.includes(WORKFLOW_DEFAULT_READS_TOKEN)) return node

  const extraReads = reads.filter(
    key => key !== WORKFLOW_DEFAULT_READS_TOKEN && key !== FULL_CONTEXT_READS_TOKEN
  )
  const data = { ...node.data }

  if (mode === 'legacy') {
    delete data.reads
  } else if (mode === 'full') {
    data.reads = [FULL_CONTEXT_READS_TOKEN]
  } else {
    data.reads = extraReads
  }

  return { ...node, data }
}

function normalizeNodesForWorkflowDefaultMode(nodes, mode) {
  return nodes.map((node) => normalizeNodeReadsForWorkflowDefaultMode(node, mode))
}

// Re-encode RF edges to wire format. Edges have no unknown fields, so this is
// always safe to derive from React Flow state at save/validate/JSON-display time.
function rfEdgesToWire(rfEdges) {
  return rfEdges.map(e => {
    const r = { from: e.source, to: e.target }
    const c = e.data?.condition
    if (c && c !== 'default') r.condition = c
    return r
  })
}

// Apply a2a-specific cleanup (drop empty rows, fill default key) before sending
// to the backend. For all other node types this is a no-op.
function cleanA2aNodes(wireNodes) {
  return wireNodes.map(n => {
    if (n.type !== 'a2a_agent') return n
    const result = { ...n }
    if (Array.isArray(result.reads)) {
      result.reads = result.reads
        .filter(r => String(r.key || '').trim() || String(r.context_key || '').trim() || r.value != null)
        .map(r => (!String(r.key || '').trim() && String(r.context_key || '').trim())
          ? { ...r, key: r.context_key }
          : r)
    }
    if (Array.isArray(result.writes)) {
      result.writes = result.writes
        .filter(w => String(w.artifact_name || '').trim() || String(w.context_key || '').trim())
        .map(w => (!String(w.context_key || '').trim() && String(w.artifact_name || '').trim())
          ? { ...w, context_key: w.artifact_name }
          : w)
    }
    return result
  })
}

function _registerMonacoSchema(monaco, workflowNodeSchema) {
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: [{
      uri: 'workflow-schema',
      fileMatch: ['internal://workflow-editor/main'],
      schema: {
        type: 'object',
        required: ['nodes', 'edges'],
        properties: {
          nodes: { type: 'array', items: workflowNodeSchema },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['from', 'to'],
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                condition: { type: 'string', enum: ['approved', 'rejected'] },
              },
            },
          },
        },
      },
    }],
  })
}

export default function WorkflowEditor() {
  // Workflow list + selection
  const [workflows, setWorkflows] = useState([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null)
  const [workflowMeta, setWorkflowMeta] = useState({
    name: '',
    description: '',
    short_description: '',
    long_description: '',
    prompts: [],
  })
  const [workflowDefaultModeOverride, setWorkflowDefaultModeOverride] = useState(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState(null)
  const [showConfigPanel, setShowConfigPanel] = useState(false)

  // Agents + A2A servers (for config panel dropdowns)
  const [agents, setAgents] = useState([])
  const [a2aServers, setA2aServers] = useState([])

  // UI state
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [editorMode, setEditorMode] = useState('visual')
  const [wireDocNodes, setWireDocNodes] = useState([])
  const [workflowJson, setWorkflowJson] = useState('')
  const [jsonError, setJsonError] = useState(null)
  const [configJsonError, setConfigJsonError] = useState(null)

  const reactFlowWrapper = useRef(null)
  const reactFlowInstance = useRef(null)
  const monacoRef = useRef(null)
  const [nodeSchema, setNodeSchema] = useState(null)

  const isSystemWorkflow = useMemo(() => {
    const wf = workflows.find(w => w.id === selectedWorkflowId)
    return wf?.tenant_id === '__system__'
  }, [workflows, selectedWorkflowId])
  const clientValidationErrors = useMemo(() => {
    const base = getWorkflowValidationErrors(nodes, workflowMeta.default_reads)
    const withPrompts = [...base, ...getWorkflowPromptIssues(workflowMeta.prompts)]
    return configJsonError ? [...withPrompts, configJsonError] : withPrompts
  }, [nodes, workflowMeta.default_reads, workflowMeta.prompts, configJsonError])

  // ─── Data Fetching ───────────────────────────────────────

  useEffect(() => {
    apiFetch('/openapi.json')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const schema = data?.components?.schemas?.WorkflowNode
        if (schema) setNodeSchema(schema)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!monacoRef.current || !nodeSchema) return
    _registerMonacoSchema(monacoRef.current, nodeSchema)
  }, [nodeSchema])

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await apiFetch('/configurations/workflows/')
      const data = await res.json()
      setWorkflows(data)
      return data
    } catch (err) {
      setError(err.message)
      return []
    }
  }, [])

  const fetchAgents = useCallback(async () => {
    try {
      const res = await apiFetch('/configurations/agents/')
      const data = await res.json()
      setAgents(data)
    } catch {
      // non-critical
    }
  }, [])

  const fetchA2aServers = useCallback(async () => {
    try {
      const res = await apiFetch('/configurations/a2a/')
      const data = await res.json()
      setA2aServers(Array.isArray(data) ? data : [])
    } catch {
      // non-critical: a2a server picker just shows the raw id if the list can't load
    }
  }, [])

  const handleNewWorkflow = () => {
    setSelectedWorkflowId(null)
    setWorkflowMeta({
      name: 'New Workflow',
      description: '',
      short_description: '',
      long_description: '',
      default_reads: undefined,
      prompts: [],
    })
    setWorkflowDefaultModeOverride(null)
    const { nodes: n, edges: e } = createEmptyWorkflow()
    setNodes(n)
    setEdges(e)
    setWireDocNodes([{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }])
    setSelectedNode(null)
    setShowConfigPanel(false)
    setConfigJsonError(null)
    setEditorMode('visual')
    setDirty(true)
    setValidationResult(null)
    setDropdownOpen(false)
  }

  const loadWorkflow = useCallback((wf) => {
    const id = wf.id
    setSelectedWorkflowId(id)
    setWorkflowMeta({
      name: wf.display_name || wf.name || '',
      ...entityDescriptionsForForm(wf),
      default_reads: hasField(wf, 'default_reads')
        ? normalizeContractKeyList(wf.default_reads)
        : undefined,
      execution_mode: wf.execution_mode,
      prompts: Array.isArray(wf.prompts) ? wf.prompts : [],
    })
    setWorkflowDefaultModeOverride(null)
    const { nodes: rfNodes, edges: rfEdges } = apiToReactFlow(wf)
    setNodes(rfNodes)
    setEdges(rfEdges)
    setWireDocNodes(wf.nodes || [])
    setSelectedNode(null)
    setShowConfigPanel(false)
    setConfigJsonError(null)
    setEditorMode('visual')
    setDirty(false)
    setValidationResult(null)
  }, [setNodes, setEdges])

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      const wfs = await fetchWorkflows()
      await fetchAgents()
      await fetchA2aServers()
      // Auto-select first workflow
      if (wfs.length > 0) {
        const first = wfs[0]
        loadWorkflow(first)
      } else {
        handleNewWorkflow()
      }
      setLoading(false)
    }
    init()
  }, [])
  // ─── Workflow Actions ────────────────────────────────────

  const handleSelectWorkflow = (wf) => {
    loadWorkflow(wf)
    setDropdownOpen(false)
  }

  const buildWorkflowBody = useCallback((overrides = {}) => {
    const body = {
      name: overrides.name ?? workflowMeta.name,
      ...entityDescriptionsForSave({
        short_description: overrides.short_description ?? workflowMeta.short_description,
        long_description: overrides.long_description ?? workflowMeta.long_description,
        description: overrides.description ?? workflowMeta.description,
      }),
      nodes: cleanA2aNodes(wireDocNodes),
      edges: rfEdgesToWire(edges),
      prompts: sanitizeWorkflowPrompts(overrides.prompts ?? workflowMeta.prompts),
    }

    const defaultReads = overrides.default_reads ?? workflowMeta.default_reads
    if (defaultReads !== undefined) {
      body.default_reads = defaultReads === null ? null : normalizeContractKeyList(defaultReads)
    }
    return body
  }, [edges, wireDocNodes, workflowMeta])

  const parseJsonRaw = () => {
    try {
      const parsed = JSON.parse(workflowJson)
      if (!parsed || typeof parsed !== 'object') throw new Error('Must be a JSON object with nodes and edges')
      if (!Array.isArray(parsed.nodes)) throw new Error('nodes must be a JSON array')
      if (!Array.isArray(parsed.edges)) throw new Error('edges must be a JSON array')
      return { nodes: parsed.nodes, edges: parsed.edges }
    } catch (e) {
      setJsonError(e.message)
      setError('JSON is invalid: ' + e.message)
      return null
    }
  }

  const handleSave = async () => {
    if (clientValidationErrors.length > 0) {
      setError(clientValidationErrors.join('; '))
      return
    }

    const newDisplayName = workflowMeta.name.trim()
    const duplicate = workflows.find(wf => {
      const wfId = wf._id || wf.id
      if (wfId === selectedWorkflowId) return false
      return (wf.display_name || wf.name) === newDisplayName
    })
    if (duplicate) {
      setError(`A workflow named "${newDisplayName}" already exists`)
      return
    }

    let body
    if (editorMode === 'json') {
      const raw = parseJsonRaw()
      if (!raw) return
      // Update canvas for visual preview (display only)
      const rf = apiToReactFlow({ nodes: raw.nodes, edges: raw.edges })
      setNodes(rf.nodes)
      setEdges(rf.edges)
      setWireDocNodes(raw.nodes)

      if (selectedNode) {
        const updated = rf.nodes.find(n => n.id === selectedNode.id)
        if (updated) setSelectedNode(updated)
      }
      // Build body directly from raw parsed JSON — no round-trip through serializer
      body = {
        name: workflowMeta.name,
        ...entityDescriptionsForSave({
          short_description: workflowMeta.short_description,
          long_description: workflowMeta.long_description,
          description: workflowMeta.description,
        }),
        nodes: raw.nodes,
        edges: raw.edges,
      }
      const dr = workflowMeta.default_reads
      if (dr !== undefined) body.default_reads = dr === null ? null : normalizeContractKeyList(dr)
      // Prompts are a form field, not part of the nodes/edges JSON, so carry them from meta.
      body.prompts = sanitizeWorkflowPrompts(workflowMeta.prompts)
    } else {
      body = buildWorkflowBody()
    }

    setSaving(true)
    setError(null)
    try {
      let res
      if (selectedWorkflowId) {
        res = await apiFetch(`/configurations/workflows/${selectedWorkflowId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        // Generate a wire-valid id from name + short suffix to avoid collisions.
        // Wire ids must match ^[a-z][a-z0-9_]{1,63}$, so a name like "3D Pipeline"
        // (slug "3d_pipeline") needs a letter prefix, and the whole thing must fit 64.
        let slug = workflowMeta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
        if (slug && !/^[a-z]/.test(slug)) slug = `wf_${slug}`
        slug = slug.slice(0, 58)
        const suffix = Date.now().toString(36).slice(-4)
        body.id = slug ? `${slug}_${suffix}` : `workflow_${suffix}`
        res = await apiFetch('/configurations/workflows/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const detail = errData.detail
        throw new Error(
          detail != null ? formatApiDetail(detail) : `Save failed (${res.status})`
        )
      }

      const saved = await res.json()
      const newId = saved.id || selectedWorkflowId
      setSelectedWorkflowId(newId)
      setDirty(false)
      await fetchWorkflows()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleValidate = async () => {
    if (clientValidationErrors.length > 0) {
      setValidationResult({ valid: false, errors: clientValidationErrors, warnings: [] })
      return
    }

    let valApiNodes, valApiEdges
    if (editorMode === 'json') {
      const raw = parseJsonRaw()
      if (!raw) return
      valApiNodes = raw.nodes
      valApiEdges = raw.edges
    } else {
      valApiNodes = cleanA2aNodes(wireDocNodes)
      valApiEdges = rfEdgesToWire(edges)
    }

    setValidating(true)
    setValidationResult(null)
    try {
      const dr = workflowMeta.default_reads
      const res = await apiFetch('/configurations/workflows/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: valApiNodes,
          edges: valApiEdges,
          ...(dr !== undefined ? { default_reads: dr === null ? null : normalizeContractKeyList(dr) } : {}),
        }),
      })

      const data = await res.json()
      setValidationResult(data)
    } catch (err) {
      setValidationResult({ valid: false, errors: [err.message] })
    } finally {
      setValidating(false)
    }
  }

  const switchToJson = () => {
    setWorkflowJson(JSON.stringify({ nodes: wireDocNodes, edges: rfEdgesToWire(edges) }, null, 2))
    setJsonError(null)
    setEditorMode('json')
  }

  const applyJson = () => {
    try {
      const parsed = JSON.parse(workflowJson)
      if (!parsed || typeof parsed !== 'object') throw new Error('Must be a JSON object with nodes and edges')
      if (!Array.isArray(parsed.nodes)) throw new Error('nodes must be a JSON array')
      if (!Array.isArray(parsed.edges)) throw new Error('edges must be a JSON array')
      const { nodes: rfNodes, edges: rfEdges } = apiToReactFlow({ nodes: parsed.nodes, edges: parsed.edges })
      setNodes(rfNodes)
      setEdges(rfEdges)
      setWireDocNodes(parsed.nodes)
      setDirty(true)
      setJsonError(null)
      setEditorMode('visual')
    } catch (e) {
      setJsonError(e.message)
    }
  }

  const handleClone = async () => {
    if (!selectedWorkflowId) return

    const cloneName = `${workflowMeta.name} (Copy)`
    let slug = cloneName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
    if (slug && !/^[a-z]/.test(slug)) slug = `wf_${slug}`
    slug = slug.slice(0, 58)
    const suffix = Date.now().toString(36).slice(-4)

    const descriptions = entityDescriptionsForSave({
      short_description: workflowMeta.short_description,
      long_description: workflowMeta.long_description,
      description: workflowMeta.description,
    })

    let body
    if (editorMode === 'json') {
      const raw = parseJsonRaw()
      if (!raw) return
      body = { name: cloneName, ...descriptions, nodes: raw.nodes, edges: raw.edges }
      const dr = workflowMeta.default_reads
      if (dr !== undefined) body.default_reads = dr === null ? null : normalizeContractKeyList(dr)
      body.prompts = sanitizeWorkflowPrompts(workflowMeta.prompts)
    } else {
      body = buildWorkflowBody({ name: cloneName })
    }
    body.id = slug ? `${slug}_${suffix}` : `workflow_${suffix}`

    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch('/configurations/workflows/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const detail = errData.detail
        throw new Error(detail != null ? formatApiDetail(detail) : `Clone failed (${res.status})`)
      }
      const saved = await res.json()
      const wfs = await fetchWorkflows()
      const cloned = wfs.find(w => w.id === saved.id)
      if (cloned) loadWorkflow(cloned)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }


  const handleDelete = async () => {
    if (!selectedWorkflowId || isSystemWorkflow) return
    if (!window.confirm('Delete this workflow?')) return
    try {
      await apiFetch(`/configurations/workflows/${selectedWorkflowId}`, { method: 'DELETE' })
      const wfs = await fetchWorkflows()
      if (wfs.length > 0) {
        loadWorkflow(wfs[0])
      } else {
        handleNewWorkflow()
      }
    } catch (err) {
      setError(err.message)
    }
  }

  // ─── React Flow Callbacks ────────────────────────────────

  const onConnect = useCallback((params) => {
    const sourceNode = nodes.find(n => n.id === params.source)
    const isApprovalGate = sourceNode?.data?.nodeType === 'approval_gate'
    const condition = params.sourceHandle || (isApprovalGate ? 'approved' : null)

    const newEdge = {
      ...params,
      id: `e-${params.source}-${params.target}-${Date.now()}`,
      type: condition ? 'conditionalEdge' : 'default',
      data: { condition: condition || 'default' },
      animated: condition === 'rejected',
      markerEnd: { type: MarkerType.ArrowClosed },
    }
    setEdges((eds) => addEdge(newEdge, eds))
    setDirty(true)
  }, [nodes, setEdges])

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node)
    setShowConfigPanel(true)
  }, [])

  const onPaneClick = useCallback(() => {
    setConfigJsonError(null)
    setSelectedNode(null)
    setShowConfigPanel(false)
  }, [])

  const handleNodeUpdate = useCallback((nodeId, newData) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...newData } } : n
      )
    )
    setSelectedNode((current) =>
      current?.id === nodeId ? { ...current, data: { ...current.data, ...newData } } : current
    )
    setWireDocNodes(prev => prev.map(n =>
      n.id === nodeId ? applyNodeFormPatch(n, newData) : n
    ))
    setDirty(true)
  }, [setNodes])

  const handleNodesChange = useCallback((changes) => {
    onNodesChange(changes)
    const removedIds = new Set(changes.filter(c => c.type === 'remove').map(c => c.id))
    if (removedIds.size > 0) {
      setWireDocNodes(prev => prev.filter(n => !removedIds.has(n.id)))
    }
    if (changes.some(c => c.type === 'position' || c.type === 'remove')) {
      setDirty(true)
    }
  }, [onNodesChange])
  
  const handleEdgesChange = useCallback((changes) => {
    onEdgesChange(changes)
    if (changes.some(c => c.type === 'remove')) {
      setDirty(true)
    }
  }, [onEdgesChange])

  // ─── Drag & Drop from Palette ────────────────────────────

  const onDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/reactflow-type')
    if (!type || !reactFlowInstance.current) return

    const position = reactFlowInstance.current.screenToFlowPosition({
      x: e.clientX,
      y: e.clientY,
    })

    const newNode = createNewNode(type, position, nodes)
    setNodes((nds) => [...nds, newNode])
    setWireDocNodes(prev => [...prev, { id: newNode.id, type }])
    setDirty(true)
  }, [nodes, setNodes])

  const onDragStart = (e, nodeType) => {
    e.dataTransfer.setData('application/reactflow-type', nodeType)
    e.dataTransfer.effectAllowed = 'move'
  }

  // ─── Render ──────────────────────────────────────────────

  const setWorkflowDefaultReads = (value) => {
    setWorkflowMeta((meta) => ({
      ...meta,
      default_reads: value,
    }))
    setDirty(true)
  }

  const updateWorkflowDefaultMode = (mode) => {
    setWorkflowDefaultModeOverride(mode)
    setNodes((currentNodes) => normalizeNodesForWorkflowDefaultMode(currentNodes, mode))
    setSelectedNode((currentNode) =>
      currentNode ? normalizeNodeReadsForWorkflowDefaultMode(currentNode, mode) : currentNode
    )
    // Sync $workflow_defaults token resolution to wireDocNodes
    if (['legacy', 'full', 'none'].includes(mode)) {
      setWireDocNodes(prev => prev.map(wireNode => {
        const reads = normalizeContractKeyList(wireNode.reads)
        if (!reads.includes(WORKFLOW_DEFAULT_READS_TOKEN)) return wireNode
        const extraReads = reads.filter(
          key => key !== WORKFLOW_DEFAULT_READS_TOKEN && key !== FULL_CONTEXT_READS_TOKEN
        )
        const result = { ...wireNode }
        if (mode === 'legacy') delete result.reads
        else if (mode === 'full') result.reads = [FULL_CONTEXT_READS_TOKEN]
        else result.reads = extraReads
        return result
      }))
    }
    const currentReads = normalizeContractKeyList(workflowMeta.default_reads)
    const currentExtra = withoutKeys(currentReads, [FULL_CONTEXT_READS_TOKEN, ...SYSTEM_BASE_READ_KEYS])
    if (mode === 'legacy') {
      setWorkflowDefaultReads(undefined)
    } else if (mode === 'none') {
      setWorkflowDefaultReads([])
    } else if (mode === 'full') {
      setWorkflowDefaultReads([FULL_CONTEXT_READS_TOKEN])
    } else if (mode === 'system_base') {
      setWorkflowDefaultReads(mergeContractKeys(SYSTEM_BASE_READ_KEYS, currentExtra))
    } else {
      setWorkflowDefaultReads(currentExtra)
    }
  }

  const updateWorkflowDefaultKeys = (keys) => {
    const mode = workflowDefaultModeOverride ?? getWorkflowDefaultMode(workflowMeta.default_reads)
    if (mode === 'system_base') {
      setWorkflowDefaultReads(mergeContractKeys(
        SYSTEM_BASE_READ_KEYS,
        withoutKeys(keys, SYSTEM_BASE_READ_KEYS),
      ))
    } else {
      setWorkflowDefaultReads(normalizeContractKeyList(keys))
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    )
  }

  const defaultReadsValues = normalizeContractKeyList(workflowMeta.default_reads)
  const defaultReadsMode = workflowDefaultModeOverride ?? getWorkflowDefaultMode(workflowMeta.default_reads)
  const defaultReadsEditable = defaultReadsMode === 'system_base' || defaultReadsMode === 'custom'
  const defaultReadsExtraValues = !defaultReadsEditable
    ? []
    : defaultReadsMode === 'system_base'
      ? withoutKeys(defaultReadsValues, SYSTEM_BASE_READ_KEYS)
      : defaultReadsValues
  const defaultReadSuggestions = defaultReadsMode === 'system_base'
    ? withoutKeys(READ_KEY_SUGGESTIONS, SYSTEM_BASE_READ_KEYS)
    : READ_KEY_SUGGESTIONS
  const effectiveDefaultReadsText = defaultReadsMode === 'legacy'
    ? 'legacy full context dump'
    : defaultReadsMode === 'full'
      ? 'all available workflow context'
      : defaultReadsValues.length > 0
        ? defaultReadsValues.join(', ')
        : 'no default context'

  return (
    <div className="h-screen bg-slate-900 flex flex-col">
      {/* ── Toolbar ──────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
        {/* Workflow selector */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 hover:border-slate-500 min-w-[200px]"
          >
            <span className="truncate">{workflowMeta.name || 'Untitled'}</span>
            {dirty && <span className="text-yellow-400 text-xs">*</span>}
            <ChevronDown className="w-4 h-4 ml-auto shrink-0" />
          </button>
          {dropdownOpen && (
            <div className="absolute z-50 mt-1 w-64 bg-slate-700 border border-slate-600 rounded-lg shadow-xl max-h-64 overflow-y-auto">
              {workflows.map(wf => (
                <button
                  key={wf.id}
                  onClick={() => handleSelectWorkflow(wf)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-600 ${
                    wf.id === selectedWorkflowId ? 'bg-blue-900/40 text-blue-200' : 'text-slate-200'
                  }`}
                >
                  <div className="font-medium truncate">{wf.display_name || wf.name}</div>
                  {wf.display_name && wf.display_name !== wf.name && (
                    <div className="text-[10px] text-slate-400 truncate">{wf.name}</div>
                  )}
                  {entityShortDescription(wf) && (
                    <div className="text-[11px] text-slate-500 truncate">{entityShortDescription(wf)}</div>
                  )}
                  {wf.tenant_id === '__system__' && (
                    <span className="text-[10px] text-yellow-400">system</span>
                  )}
                </button>
              ))}
              <button
                onClick={handleNewWorkflow}
                className="w-full text-left px-3 py-2 text-sm text-green-400 hover:bg-slate-600 border-t border-slate-600"
              >
                <Plus className="w-3 h-3 inline mr-1" /> New Workflow
              </button>
            </div>
          )}
        </div>

        {/* Workflow name input */}
        <input
          type="text"
          value={workflowMeta.name}
          onChange={(e) => { setWorkflowMeta(m => ({ ...m, name: e.target.value })); setDirty(true) }}
          disabled={isSystemWorkflow}
          className="px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 w-48 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          placeholder="Workflow name"
        />

        <input
          type="text"
          maxLength={SHORT_DESCRIPTION_MAX_LEN}
          value={workflowMeta.short_description ?? ''}
          onChange={(e) => { setWorkflowMeta(m => ({ ...m, short_description: e.target.value })); setDirty(true) }}
          disabled={isSystemWorkflow}
          className="px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 w-56 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          placeholder="Short description"
        />

        {/* Visual / JSON toggle */}
        <div className="flex rounded overflow-hidden border border-slate-600">
          <button
            type="button"
            onClick={() => editorMode === 'json' ? applyJson() : undefined}
            className={`px-3 py-1.5 text-xs ${editorMode === 'visual' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
          >
            Visual
          </button>
          <button
            type="button"
            onClick={() => editorMode === 'visual' ? switchToJson() : undefined}
            className={`px-3 py-1.5 text-xs ${editorMode === 'json' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
          >
            JSON
          </button>
        </div>

        <div className="flex-1" />

        {/* Action buttons */}
        <button
          onClick={handleValidate}
          disabled={validating}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-50"
        >
          {validating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
          Validate
        </button>

        <button
          onClick={handleSave}
          disabled={saving || isSystemWorkflow || clientValidationErrors.length > 0}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white disabled:opacity-50"
        >
          {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save
        </button>

        {selectedWorkflowId && (
          <button
            onClick={handleClone}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-50"
          >
            <Copy className="w-3.5 h-3.5" /> Clone
          </button>
        )}

        {!isSystemWorkflow && selectedWorkflowId && (
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/50 border border-red-700 rounded text-sm text-red-300 hover:bg-red-900"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="border-l border-slate-600 h-6 mx-1" />
        <TopNavLinks />
      </div>

      <div className="flex items-start gap-3 px-4 py-2 bg-slate-800/80 border-b border-slate-700 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-slate-300 mb-1">Long description</div>
          <textarea
            value={workflowMeta.long_description ?? ''}
            onChange={(e) => { setWorkflowMeta(m => ({ ...m, long_description: e.target.value })); setDirty(true) }}
            disabled={isSystemWorkflow}
            placeholder="Optional workflow details"
            rows={2}
            className="w-full max-w-3xl px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 disabled:opacity-50 resize-y"
          />
        </div>
      </div>

      <div className="flex items-start gap-3 px-4 py-2 bg-slate-800/80 border-b border-slate-700 shrink-0">
        <div className="w-36 pt-1">
          <div className="text-xs font-medium text-slate-300">Example prompts</div>
          <div className="text-[11px] text-slate-500">Offered on the launch screen</div>
        </div>
        <div className="flex flex-col gap-2 min-w-[340px] max-w-3xl flex-1">
          {(workflowMeta.prompts || []).map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <input
                type="text"
                value={p.name ?? ''}
                onChange={(e) => { const v = e.target.value; setWorkflowMeta(m => ({ ...m, prompts: (m.prompts || []).map((row, idx) => idx === i ? { ...row, name: v } : row) })); setDirty(true) }}
                disabled={isSystemWorkflow}
                maxLength={WORKFLOW_PROMPT_NAME_MAX_LEN}
                placeholder="Name"
                className="w-40 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 disabled:opacity-50"
              />
              <textarea
                value={p.text ?? ''}
                onChange={(e) => { const v = e.target.value; setWorkflowMeta(m => ({ ...m, prompts: (m.prompts || []).map((row, idx) => idx === i ? { ...row, text: v } : row) })); setDirty(true) }}
                disabled={isSystemWorkflow}
                maxLength={WORKFLOW_PROMPT_TEXT_MAX_LEN}
                placeholder="Prompt text — pre-fills the request field on launch"
                rows={2}
                className="flex-1 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 disabled:opacity-50 resize-y"
              />
              <button
                type="button"
                onClick={() => { setWorkflowMeta(m => ({ ...m, prompts: (m.prompts || []).filter((_, idx) => idx !== i) })); setDirty(true) }}
                disabled={isSystemWorkflow}
                title="Remove prompt"
                className="p-1.5 text-slate-400 hover:text-red-300 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {!isSystemWorkflow && (
            <button
              type="button"
              onClick={() => { setWorkflowMeta(m => ({ ...m, prompts: [...(m.prompts || []), { name: '', text: '' }] })); setDirty(true) }}
              className="self-start flex items-center gap-1.5 px-2 py-1 text-xs text-green-400 hover:text-green-300"
            >
              <Plus className="w-3 h-3" /> Add prompt
            </button>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3 px-4 py-2 bg-slate-800/80 border-b border-slate-700 shrink-0">
        <div className="w-36 pt-1">
          <div className="text-xs font-medium text-slate-300">Workflow Default Reads</div>
          <div className="text-[11px] text-slate-500">Inherited by phase nodes</div>
        </div>
        <div className="flex flex-col gap-1.5 min-w-[340px] max-w-[560px] flex-1">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => updateWorkflowDefaultMode('legacy')}
              disabled={isSystemWorkflow}
              className={`px-2 py-1 rounded border text-[11px] disabled:opacity-50 ${
                defaultReadsMode === 'legacy'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              Legacy full context
            </button>
            <button
              type="button"
              onClick={() => updateWorkflowDefaultMode('system_base')}
              disabled={isSystemWorkflow}
              className={`px-2 py-1 rounded border text-[11px] disabled:opacity-50 ${
                defaultReadsMode === 'system_base'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              System base + extra
            </button>
            <button
              type="button"
              onClick={() => updateWorkflowDefaultMode('custom')}
              disabled={isSystemWorkflow}
              className={`px-2 py-1 rounded border text-[11px] disabled:opacity-50 ${
                defaultReadsMode === 'custom'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              Custom defaults
            </button>
            <button
              type="button"
              onClick={() => updateWorkflowDefaultMode('none')}
              disabled={isSystemWorkflow}
              className={`px-2 py-1 rounded border text-[11px] disabled:opacity-50 ${
                defaultReadsMode === 'none'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              No context
            </button>
            <button
              type="button"
              onClick={() => updateWorkflowDefaultMode('full')}
              disabled={isSystemWorkflow}
              className={`px-2 py-1 rounded border text-[11px] disabled:opacity-50 ${
                defaultReadsMode === 'full'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-slate-700/60 border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              Full context
            </button>
          </div>
          {defaultReadsMode === 'system_base' && (
            <div className="flex flex-wrap gap-1">
              {SYSTEM_BASE_READ_KEYS.map(key => (
                <span
                  key={key}
                  className="px-1.5 py-0.5 text-[10px] bg-slate-700/80 border border-slate-600 rounded text-slate-300"
                >
                  locked: {key}
                </span>
              ))}
            </div>
          )}
          {defaultReadsEditable && (
            <ChipInput
              values={defaultReadsExtraValues}
              onChange={updateWorkflowDefaultKeys}
              suggestions={defaultReadSuggestions}
              placeholder="Add workflow read keys"
              disabled={isSystemWorkflow}
            />
          )}
          <div className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-950/30 px-2 py-1 text-[11px]">
            <span className="font-medium uppercase tracking-wide text-blue-300">Effective defaults</span>
            <span className="truncate text-slate-200">{effectiveDefaultReadsText}</span>
          </div>
        </div>
      </div>

      {/* Validation / Error bar */}
      {(error || validationResult || clientValidationErrors.length > 0) && (
        <div className={`px-4 py-2 text-sm shrink-0 ${
          error ? 'bg-red-900/40 text-red-300' :
          validationResult?.valid ? 'bg-green-900/40 text-green-300' :
          'bg-red-900/40 text-red-300'
        }`}>
          {error && <><AlertTriangle className="w-3.5 h-3.5 inline mr-1" />{error}</>}
          {!error && !validationResult && clientValidationErrors.length > 0 && (
            <><AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
              {clientValidationErrors.join('; ')}
            </>
          )}
          {!error && validationResult?.valid && <><CheckCircle className="w-3.5 h-3.5 inline mr-1" />Workflow is valid</>}
          {!error && validationResult && !validationResult.valid && (
            <><AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
              {(validationResult.errors || []).join('; ') || 'Validation failed'}
            </>
          )}
          <button
            onClick={() => { setError(null); setValidationResult(null) }}
            className="ml-3 text-xs underline opacity-70 hover:opacity-100"
          >dismiss</button>
        </div>
      )}

      {/* ── Main Content ──────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {editorMode === 'json' ? (
          <div className="flex-1 flex flex-col p-4 gap-3 overflow-auto">
            {jsonError && (
              <div className="text-sm text-red-400 bg-red-900/30 border border-red-700 rounded px-3 py-2">
                {jsonError}
              </div>
            )}
            <div className="flex flex-col flex-1 min-h-0">
              <span className="text-xs text-slate-400 mb-1">Workflow JSON</span>
              <div className="flex-1 min-h-0 border border-slate-600 rounded overflow-hidden">
                <Editor
                  height="100%"
                  language="json"
                  theme="vs-dark"
                  value={workflowJson}
                  path="internal://workflow-editor/main"
                  onChange={v => { setWorkflowJson(v ?? ''); setJsonError(null); setDirty(true) }}
                  beforeMount={monaco => {
                    monacoRef.current = monaco
                    if (nodeSchema) _registerMonacoSchema(monaco, nodeSchema)
                  }}
                  onMount={(_editor, monaco) => {
                    monacoRef.current = monaco
                    if (nodeSchema) _registerMonacoSchema(monaco, nodeSchema)
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-slate-500">Save applies JSON directly; or switch to Visual to preview changes on the canvas.</p>
          </div>
        ) : (
          <>
            {/* Palette sidebar */}
            <div className="w-[180px] bg-slate-800/80 border-r border-slate-700 p-3 flex flex-col gap-2 shrink-0">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                Node Palette
              </h3>
              {PALETTE_ITEMS.map(item => {
                const Icon = item.icon
                return (
                  <div
                    key={item.type}
                    draggable
                    onDragStart={(e) => onDragStart(e, item.type)}
                    className={`flex items-center gap-2 px-3 py-2 border rounded cursor-grab active:cursor-grabbing text-xs font-medium select-none ${COLOR_MAP[item.color]}`}
                  >
                    <GripVertical className="w-3 h-3 opacity-40 shrink-0" />
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {item.label}
                  </div>
                )
              })}
            </div>

        {/* React Flow canvas */}
        <div className="flex-1" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onInit={(instance) => { reactFlowInstance.current = instance }}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={isSystemWorkflow ? null : ['Backspace', 'Delete']}
            className="bg-slate-900"
          >
            <Controls className="!bg-slate-800 !border-slate-600 !shadow-lg [&>button]:!bg-slate-700 [&>button]:!border-slate-600 [&>button]:!text-slate-300 [&>button:hover]:!bg-slate-600" />
            <MiniMap
              nodeColor={(n) => {
                const type = n.data?.nodeType || n.type
                const map = { start: '#22c55e', end: '#ef4444', phase: '#3b82f6', approval_gate: '#eab308', execution: '#a855f7', a2a_agent: '#06b6d4', deploy: '#f97316', validator: '#14b8a6', tool: '#6366f1', map: '#ec4899' }
                return map[type] || '#64748b'
              }}
              className="!bg-slate-800 !border-slate-600"
              maskColor="rgba(15, 23, 42, 0.7)"
            />
            <Background color="#334155" gap={20} size={1} />
          </ReactFlow>
        </div>

        {/* Config panel */}
        {showConfigPanel && selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            agents={agents}
            a2aServers={a2aServers}
            allNodes={nodes}
            workflowDefaultReads={workflowMeta.default_reads}
            workflowDefaultMode={defaultReadsMode}
            workflowExecutionMode={workflowMeta.execution_mode}
            onUpdate={handleNodeUpdate}
            onClose={() => {
              setConfigJsonError(null)
              setShowConfigPanel(false)
              setSelectedNode(null)
            }}
            onSwitchToJson={switchToJson}
            onJsonFieldErrorChange={setConfigJsonError}
          />

        )}
      </>
    )}
  </div>
</div>
)
}
